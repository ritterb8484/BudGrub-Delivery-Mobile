# Driver app (E10): API changes for `apps/api`

> **Status (2026-11-10): ported.** These changes are implemented in the BudGrub monorepo (`apps/api`, migration
> `010_driver_app.sql`, API version 0.3.0) and covered there by `apps/api/test/smoke/smoke-driver.mjs`. Where the port
> differs from the text below, the API is the reference:
>
> - **Error bodies** are `{ error: "message", details: { code, ... } }`. The app reads the code from `details`
>   (`src/api/errors.ts`).
> - **Manifest lock.** The API locks the manifest at departure, so an offered trip has `manifestLockedAt: null`. The load
>   attestation is tied to the trip's `planVersion` instead (the app sends `planVersion` with `/load`); amending a
>   planned trip clears it. `MANIFEST_UNLOCKED` does not exist.
> - **`LOAD_NOT_ATTESTED` at departure** is enforced per dispensary (`tenants.require_load_attestation`, default off),
>   because the web driver console has no scanner. `tenants.load_photo_required` drives `loadPhotoRequired`.
> - **Decline** cancels the trip and returns its orders to the ready list (a trip always has an agent in the API's
>   schema); the decline is recorded in `driver_trip_declines`.
> - **Field names.** Stops carry `lat`/`lng`, `etaAt` and `dropOffNote`; mutations answer `{ trip }`, the pay link
>   `{ link }`. `src/api/normalize.ts` maps these onto the shapes the screens read.
> - **Location pings** may use `at` or `recordedAt`.
> - **`PLAN_NOT_ACKNOWLEDGED`** is not enforced server-side (section 9): the app blocks stop actions until the plan is
>   acknowledged, and enforcing it on the server would permanently reject stop actions recorded offline before an
>   amendment arrived.
> - **Push (section 10).** Both kinds are supported: native tokens go through FCM, Expo push tokens through Expo's push
>   service. Notification `data.type` is the template name (`driver_trip_assigned`, `driver_plan_amended`, …).
> - **Not ported:** per-item `weightG`, `recipientFirstName`, trip value caps, `dwellThresholdSec`, and the compliance
>   matrix entries at the end of this file.

The driver app in `apps/driver` needs the API changes below. This repository does not contain `apps/api`, so they are
**specified here and implemented in `apps/mock-api`** (the executable reference, covered by `node:test` and the smoke
suite). Port each item into the monorepo:

- routes in `apps/api/src/routes/admin/dispatch.ts`, `routes/session.ts` and `routes/admin/compliance.ts`;
- OpenAPI in `apps/api/src/openapi/index.ts` and `schemas.ts`, then `pnpm openapi:emit` and `pnpm openapi:check`;
- migration `010_driver_app.sql` (draft in `docs/server-drafts/010_driver_app.sql`);
- compliance rules in `docs/compliance-matrix.yaml` (entries at the end of this file), `pnpm matrix` at zero missing.

Status codes and error bodies follow the shape the app parses: `{ code, message, ...details }` (the client also accepts
`{ error: { code, message } }`).

## 1. Third OIDC client: `driver` (BUD-67)

`apps/api/src/config.ts` client redirect URIs gain:

```ts
driver: ["budgrub-driver://auth/callback"]
```

- `POST /api/auth/start` accepts `{ client: "driver", redirectUri?: string }`. `redirectUri` must be registered for the client
  (`400 REDIRECT_NOT_ALLOWED` otherwise); it defaults to the first registered URI.
- Keycloak: add `budgrub-driver://auth/callback` to the redirect URIs of the client the API uses (public client, PKCE).
- `KEYCLOAK_MODE=stub`: `/api/auth/stub/login` must redirect to the custom scheme for this client.
- The app sends the anonymous session token as `Authorization: Bearer <session token>` on `auth/start` and
  `auth/callback`. **Check this against `apps/admin/src/lib/api.ts`** and adjust `src/api/client.ts` if the web sends it
  differently.

## 2. `GET /api/admin/driver/trips` additions

Additive, optional fields (the web console ignores them):

| Field | Used for |
|---|---|
| `stops[].address.lat`, `.lng` | route preview, next-stop map, navigation hand-off, geofences |
| `stops[].recipientFirstName`, `stops[].phone` | offer screen shows first name only; tap-to-call |
| `stops[].items[].weightG` | per-item weight on the offer (BUD-77) |
| `stops[].eta` | per-stop ETA from `services/tracking.ts` |
| `capFlowerEquivG`, `valueCents`, `capValueCents` | weight/value against the per-trip cap (BUD-77) |
| `dispensary { name, lat, lng }`, `geofenceRadiusM` | store geofence, return-leg navigation (BUD-88) |
| `dwellThresholdSec` | dwell prompt threshold, default 180 (BUD-88) |
| `loadPhotoRequired` | dispensary SOP flag for the sealed-load photo (BUD-83) |
| `load { scannedTags, attestedAt, photoUrl }` | server-confirmed load attestation (BUD-83) |
| `lastSequence` | last processed device event sequence for the trip (BUD-124) |

## 3. `POST /api/admin/driver/trips/{id}/decline` (BUD-77, new)

Body `{ reason: string }` (≥ 3 chars). Role driver; the trip must be assigned to the caller and `planned`.

- Unassigns the driver and returns the trip to the dispatch pool; clears any load attestation.
- Audits the decline on the driver record (`driver_trip_declines`) and the trip timeline.
- `200 { ok: true, tripId, pool: true }` · `400 REASON_REQUIRED` · `409 TRIP_NOT_DECLINABLE` · `404 TRIP_NOT_FOUND`.

## 4. `POST /api/admin/driver/trips/{id}/load` (BUD-83, new; idempotent + sequenced)

```json
{
  "scans": [{ "tag": "1A40…", "at": "ISO", "result": "matched" | "duplicate" | "unknown" }],
  "attestation": { "sealed": true, "notVisible": true, "lockbox": true, "attestedAt": "ISO" },
  "manifestLockedAt": "ISO (the lock the device scanned against)",
  "photo": { "mime": "image/jpeg", "dataBase64": "…" }
}
```

- Every Metrc tag of every non-cancelled stop matched exactly once, no stray tag: else `422 LOAD_MISMATCH { unknown, missing, duplicates }`.
- All three attestation flags true: else `422 ATTESTATION_INCOMPLETE`.
- `manifestLockedAt` differs from the trip's: `409 MANIFEST_CHANGED`. Manifest unlocked: `409 MANIFEST_UNLOCKED`. Departed: `409 TRIP_ALREADY_DEPARTED`.
- `loadPhotoRequired` and no photo: `422 PHOTO_REQUIRED`. The photo is written to the evidence storage used by exports
  (`EXPORTS_DIR` locally) and its URL stored on the load.
- `201 { ok: true, load }`. Stored in `trip_loads` (one row per trip; replaced on a new attestation).
- **Re-issuing the manifest (lock timestamp moves) deletes the trip's load row.**

## 5. `depart` refuses without an attested load (BUD-83)

`POST /api/admin/dispatch/trips/{id}/depart` additionally returns `409 LOAD_NOT_ATTESTED` when the trip has no load
row for its current manifest lock. The existing checks stay (licensed hours, unlocked manifest, cap, Metrc degraded
without `manualManifest`). The dispatcher path with a manual manifest still needs the load attestation.

## 6. `POST /api/admin/driver/trips/{id}/events` (BUD-88, new; idempotent + sequenced)

```json
{ "kind": "fuel_stop" | "dwell", "lat": 0, "lng": 0, "startedAt": "ISO", "endedAt": "ISO|null", "note": "…", "photo": { "mime", "dataBase64" } }
```

- `fuel_stop` needs `startedAt` and `endedAt` (`400 TIMES_REQUIRED`); the receipt photo goes to evidence storage.
- `dwell` is posted by the device when its dwell detector fires (the server's own unauthorized-stop detection in
  `services/tracking.ts` stays authoritative).
- Trip must be departed (`409 TRIP_NOT_DEPARTED`). `201 { event }`. Stored in `trip_events`; shown on the admin trip timeline.
- Unauthorized stops are **not** posted here: they go to `POST /api/admin/incidents` with `kind: "unauthorized_stop"`.

## 7. Idempotency and ordering (BUD-124)

Applies to the stop actions (`/stops/{orderId}/{action}`), `/location`, `/load` and `/events`.

Request: header `Idempotency-Key: <uuid event id>`; body adds `sequence` (positive integer, per trip, starting at 1) and `deviceTs`.

1. **Seen key** (per trip): return the stored status and body with `replayed: true`. Nothing is re-applied.
2. **`sequence !== trip.last_event_sequence + 1`**: `409 { code: "OUT_OF_ORDER", expectedSequence, receivedSequence }`. Nothing is stored.
   The app resolves it: if `expectedSequence` is lower it re-sends from the gap; if higher it renumbers its pending events from `expectedSequence`.
3. Otherwise process. **Any 2xx or 4xx outcome consumes the sequence** and is stored with its response
   (`trip_device_events`); a 5xx does not, so the device retries the same event.
4. `sequence` without `Idempotency-Key`: `400 IDEMPOTENCY_KEY_REQUIRED`.
5. **Neither header nor `sequence`**: today's behaviour, unchanged. The web driver console keeps working.

`POST /api/admin/incidents` accepts `Idempotency-Key` too (scoped per staff member, no sequence), so an incident filed
offline and replayed is created once. Response bodies from replays carry outcomes the app shows in its sync log:
stop `deliver`/`return` include `metrc: { status }`, incidents include `number`.

Implementation notes: lock the trip row (`SELECT … FOR UPDATE`) around check-and-advance so two concurrent requests
cannot both pass the sequence check; insert the `trip_device_events` row in the same transaction as the side effect.

## 8. `id-check` stop action

Body additions (optional): `nameConfirmed: boolean` (the agent confirmed a minor spelling variance on screen),
`source: "pdf417" | "manual" | <sdk id>`. Server rules unchanged in spirit: accepted type (NAC 678B.306 list = `idTypes`),
unexpired, 21+, name match — a close match passes only with `nameConfirmed`. Log only `ok`, `reasons`, `idType`,
`last4`, `dobYear`, `at`, `agent`, `source`; do not persist the full DOB or the name on ID. Response keeps
`{ idCheck: { ok, reasons } }` as the web console expects.

## 9. Plan amendments

The app blocks stop actions until `planAcknowledgedVersion === planVersion`. The mock also refuses stop actions
server-side with `409 PLAN_NOT_ACKNOWLEDGED`; **check whether `routes/admin/dispatch.ts` already does** and add it if
not, so the rule cannot be bypassed. Push template `plan_amended` should carry `data: { type: "plan_amended", tripId, version }`.

## 10. Push token kind (decision needed)

The stories say "Expo push token"; `services/notifications.ts` sends staff pushes through **FCM**. An Expo push token
cannot be sent through FCM directly. The app supports both (`EXPO_PUBLIC_PUSH_TOKEN_KIND`):

- `device` (default): registers the native token — FCM on Android, **APNs** on iOS. Android works with the current
  sender; iOS needs either APNs in `services/notifications.ts` or Firebase on iOS.
- `expo`: registers an Expo push token; the API then sends via Expo's push service (which fronts FCM and APNs).

`POST /admin/driver/devices` should store `kind` if both are kept.

## Compliance matrix additions (`docs/compliance-matrix.yaml`)

```yaml
- id: NAC-678B.321-load-scan
  rule: Every package on the manifest is scanned and the sealed load attested before departure
  refs: [NAC 678B.321, NAC 678B.327]
  enforced_by: [apps/api/src/routes/admin/dispatch.ts#depart LOAD_NOT_ATTESTED, apps/api/src/routes/admin/dispatch.ts#load]
  tests: [apps/api/test/driver-load.test.ts, apps/api/test/smoke/smoke-driver.mjs]
- id: NAC-678B.327-trip-decline-audit
  rule: A declined trip returns to the dispatch pool and the decline is recorded on the driver record
  refs: [NAC 678B.327(9)]
  enforced_by: [apps/api/src/routes/admin/dispatch.ts#decline]
- id: NAC-678B.321-fuel-stop
  rule: Fuel stops during a delivery trip are recorded with location and times
  refs: [NAC 678B.321(10)]
  enforced_by: [apps/api/src/routes/admin/dispatch.ts#events]
- id: E10-ordered-event-sync
  rule: Device compliance events are idempotent per event id and applied in sequence per trip
  refs: [BUD-124]
  enforced_by: [apps/api/src/services/deviceEvents.ts]
```
