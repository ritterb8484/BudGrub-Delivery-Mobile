# Driver pilot setup

The standalone Expo app is the combined food and cannabis client. Verify against the BudGrub API through migration
`023_convenience_pickup_backfill.sql`.

## Configure dispatch and settlement

- In Admin, set delivery access in **Staff**, activate eligible food profiles in **Food couriers**, and save an exact
  pickup address, entrance or counter label, and on-site instructions for each kitchen and the convenience station.
  When `REQUIRE_COURIER_PICKUP_LOCATION=true`, orders with an unresolved pickup location wait for configuration.
- Company Operations packs convenience items from **Food couriers** and marks their ticket ready. The handoff uses the
  station's code. Mixed orders carry a ticket for each kitchen and for the convenience station. The driver can hold
  multiple orders on the same food shift, up to `COURIER_BATCH_LIMIT` (default four).
- For recovery, choose the affected order in the courier's record. Requeue is available before pickup. For a picked-up
  item, confirm physical custody before handing off or cancelling. Picked-up stock is kept out of sellable inventory
  unless staff separately verify and record a return.
- Keep `DELIVERY_VEHICLE_POLICY=dedicated`. A future policy change can allow sequential use of an approved shared
  vehicle with an active-work lock. The same vehicle cannot work both modes concurrently.
- Open **Courier settlements**, choose the courier and cutoff, and create a draft from unallocated earnings.
  Company finance approves the exact amount, pays through BudGrub's existing ACH, payroll, or check process,
  and reconciles the payment reference and amount. The downloadable statement lists the ledger lines used.
  Couriers see approved and paid settlements in Earnings.
- Check dispatch and incident recipients before a shift. Tenant owners, dispatchers, compliance managers, and
  designated contacts receive configured email/SMS alerts. Verify provider callbacks at
  `/api/webhooks/sms-status` and `/api/webhooks/email-status`. Watch a sent alert move to delivered or failed in Admin.

## Evidence and recovery

The native build uses SQLCipher with a device-local key. On first launch it copies legacy local records before
removing the old plaintext database. Active food snapshots expire after 24 hours. Settled food queue records are
pruned after seven days. Unsent events remain until they can sync.

New server-side proof photos, load/fuel evidence, and courier documents live in the database using the API's
envelope encryption. Back up the database and keep the KMS key available during restore. On the host that still has
the legacy evidence volume, run `pnpm --filter @budgrub/api evidence:backfill-driver` against the migrated database.
Keep the old volume until the backfill and a restore rehearsal verify that legacy links still resolve.

## Signed staging verification

- Set `EXPO_PUBLIC_API_BASE` and `EAS_PROJECT_ID` for staging and production. Configure Expo push credentials for
  both platforms, the Android Google Services file and maps key, and the food dispatch phone.
- Register `budgrub-driver-staging://auth/callback` in staging Keycloak and set
  `KEYCLOAK_DRIVER_REDIRECT_URI` to the same value on the staging API. Production uses
  `budgrub-driver://auth/callback`.
- Run the standalone **Driver verification and signed builds** workflow for staging with `EXPO_TOKEN`, the workflow
  environment variables, and signing credentials configured. On physical iOS and Android devices verify foreground,
  background, and cold-start notification taps. Exercise timed food offers, plan amendments, return notices, masked calls,
  live payment-provider test cases, and emergency-call links.
- Enable `DRIVER_REQUIRE_TRACE_READINESS=true` in staging. Test denied location permission, a stale GPS fix, loss of
  signal while moving, app restart, dispatcher-initiated departure, and remote trip closure. Verify dispatch sees a
  trace-gap incident and that the phone stops tracking when it returns to food mode.
- On a device with an existing trip queue, upgrade the app and verify pending events survive encryption migration.
  Collect a food order, go offline, restart, open the saved stops, queue proof, and reconnect. Confirm the server
  receives each action once and no longer exposes the delivered address in the offline batch.
