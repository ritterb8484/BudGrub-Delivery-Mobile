# BudGrub Delivery Mobile

The native **BudGrub driver app** (Jira epic E10 / BUD-10, cannabis delivery mode) for iOS and Android, built with
Expo SDK 58 (React Native 0.88, Expo Router), plus a mock of the driver API it talks to.

```
apps/driver           React Native / Expo app (BUD-67, 77, 83, 88, 101, 124)
apps/mock-api         Mock of the BudGrub driver API incl. the E10 additions (node:test + smoke suite)
packages/design-tokens tokens.json (stand-in; same keys as the monorepo's packages/design-tokens)
docs/driver-api-changes.md        API changes apps/api needs (contract implemented by the mock)
docs/server-drafts/010_driver_app.sql  Migration draft (tested on Postgres 16 with stub tables)
```

This app mirrors the web driver console (`apps/admin/src/pages/DriverTrip.tsx` in the BudGrub monorepo): same trip flow,
copy, cash and float rules, and the same endpoints. When it moves into the monorepo as `apps/driver`, swap
`src/api/types.ts` for `@budgrub/api-client` and `packages/design-tokens` for the real one.

## Driver app

### Setup

Requirements: Node 22.13+, pnpm 10, Xcode 26.4+ (iOS 16.4+ simulator) and/or Android Studio (API 24+ emulator).

```bash
pnpm install
cp apps/driver/.env.example apps/driver/.env      # EXPO_PUBLIC_API_BASE etc.
pnpm mock-api                                      # http://localhost:4000/api, KEYCLOAK_MODE=stub
cd apps/driver
npx expo run:ios        # or: npx expo run:android  (builds a development client)
```

The app uses native modules outside Expo Go's guarantees (background location task, maps, camera barcode scanning),
so run it as a **development build** (`expo run:*` or `eas build --profile development`), not in Expo Go.

On the Android emulator `localhost` in `EXPO_PUBLIC_API_BASE` is rewritten to `10.0.2.2` in development builds.

### Sign-in (stub identity)

The app signs in through the API's OIDC flow in an auth-session browser:
`POST /api/session` → `POST /api/auth/start { client: "driver" }` → authorize page → `budgrub-driver://auth/callback`
→ `POST /api/auth/callback`. The staff token is stored in the Keychain/Keystore (`expo-secure-store`); the staff record
is refreshed on every foreground and any 401 returns to sign-in.

With `KEYCLOAK_MODE=stub` (the mock always is) the authorize page lists test identities:

| Identity | Role | Result |
|---|---|---|
| **Jamal Pierce** (`stub-jamal`) | driver, active agent card | cannabis mode |
| Rosa Delgado (`stub-rosa`) | driver, expired agent card | courier placeholder only |
| Dana Whitfield (`stub-dana`) | dispatcher | no driver modes |

### Deep link

Scheme `budgrub-driver`, callback `budgrub-driver://auth/callback`. Register it as the third OIDC client in
`apps/api/src/config.ts` and in Keycloak (see `docs/driver-api-changes.md` §1). Test on a simulator:
`xcrun simctl openurl booted "budgrub-driver://auth/callback?code=x&state=y"`.

### EAS profiles

| Profile | `APP_VARIANT` | Bundle id | API base | Distribution |
|---|---|---|---|---|
| `development` | development | `com.budgrub.driver.dev` | `http://localhost:4000/api` | dev client, iOS simulator |
| `development-device` | development | `com.budgrub.driver.dev` | (set `EXPO_PUBLIC_API_BASE`) | dev client, devices |
| `staging` | staging | `com.budgrub.driver.staging` | `https://staging-api.budgrub.com/api` | internal |
| `production` | production | `com.budgrub.driver` | `https://api.budgrub.com/api` | stores |

```bash
npx eas-cli@latest init                       # once: creates the EAS project; set EAS_PROJECT_ID
npx eas-cli@latest env:create --name GOOGLE_MAPS_ANDROID_API_KEY --environment production --visibility secret
npx eas-cli@latest build --profile development --platform ios
npx eas-cli@latest update --channel staging   # OTA updates per channel (runtimeVersion: fingerprint)
```

The staging/production API hosts in `eas.json` are placeholders; set the real ones there or as EAS env vars. Secrets
(Google Maps key, EAS project id) live in EAS environment variables, never in the repo.

### Environment variables

See `apps/driver/.env.example`: `EXPO_PUBLIC_API_BASE`, `APP_VARIANT`, `EXPO_PUBLIC_PUSH_TOKEN_KIND` (`device` = native
FCM/APNs token for the API's FCM sender, `expo` = Expo push token), `EAS_PROJECT_ID`, `GOOGLE_MAPS_ANDROID_API_KEY`.

### What the app does

- **Foundation (BUD-67):** OIDC sign-in, secure token storage, foreground refresh, 401 → sign-in; cannabis mode only for
  an active, disclosed, unexpired agent (else the food-courier placeholder, mode switch kept); push registration on
  sign-in / removal on sign-out; explainer screens before the notification, foreground and "Always" location prompts.
  A cannabis shift cannot depart without Always location.
- **Trip acceptance (BUD-77):** offer with first names, addresses, items, Metrc tags, weights, per-stop totals, weight
  and value against the cap, manifest lock state and a route preview with server ETAs; accept, decline with reason;
  "manifest changed" when the plan version or manifest lock moves after acceptance.
- **Load scan (BUD-83):** camera scan of every Metrc tag against the manifest; blocking duplicate / not-on-manifest
  screens with "contact dispensary"; sealed-load attestation (+ photo when the SOP flag requires it); departure waits
  for the server to confirm the load.
- **Navigation and trace (BUD-88):** next stop only (in-app map + hand-off to Apple/Google Maps), no reorder/skip;
  background trace every 10–15 s batched to the location endpoint; on-device dwell detection outside the store and
  stop geofences prompts "Fuel stop" or "Report unauthorized stop"; plan amendments arrive by push and must be
  acknowledged before the next stop action.
- **ID verification (BUD-101):** scanner adapter interface with a PDF417/AAMVA licence reader and manual entry;
  on-device checks (accepted type, expiry, 21+, fuzzy name match with manual confirm) then the server-enforced
  `id-check`; result read aloud; retry or return, no override; no ID images.
- **Offline and ordered sync (BUD-124):** trip payload cached in SQLite; every event written to a durable queue with a
  per-trip sequence and device timestamp before any network call; replayed in order with `Idempotency-Key`;
  `OUT_OF_ORDER` resolved by gap replay or rebase; queued count and last sync always visible; trip close blocked until
  the queue is empty.
- **Incidents:** crash (12 h), theft/loss (immediately), unauthorized stop, other — queued like every other event.

### Tests

```bash
pnpm --filter @budgrub/driver test        # jest-expo: queue, AAMVA parser, dwell, ID validator, load scan, overlay, gating
                                          # + integration project: the app's queue/sender against the mock API over HTTP
pnpm --filter @budgrub/driver typecheck
pnpm --filter @budgrub/driver build       # expo export: Hermes bundles for iOS and Android
pnpm --filter @budgrub/mock-api test      # node:test: new endpoints, idempotent replay, out-of-order, gating
pnpm smoke                                # smoke-driver: one trip end to end through the API
SMOKE_BASE=http://localhost:4000/api pnpm smoke   # same suite against a running API (stub mode)
```

## Mock API

`pnpm mock-api` serves the driver endpoints in memory on port 4000. Dispatch-side controls for manual testing:

```bash
curl -XPOST localhost:4000/api/__mock/reset                       # fresh trip for Jamal
curl -XPOST localhost:4000/api/__mock/assign                      # offer another trip
curl -XPOST localhost:4000/api/__mock/trips/<tripId>/amend-plan   # push-less plan amendment (v+1)
curl -XPOST localhost:4000/api/__mock/trips/<tripId>/reissue-manifest
curl -XPOST localhost:4000/api/__mock/trips/<tripId>/stops/<orderId>/pay   # customer pays the Pay by Bank link
curl -XPOST localhost:4000/api/__mock/metrc -d '{"degraded":true}' -H 'content-type: application/json'
curl localhost:4000/api/__mock/state
```

Evidence photos are written to `EXPORTS_DIR` (default `apps/mock-api/.data/evidence`).
