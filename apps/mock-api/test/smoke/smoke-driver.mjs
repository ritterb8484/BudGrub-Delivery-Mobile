import assert from "node:assert/strict";
import { ALL_CHECKLIST, ATTEST, client, device, scansFor, signIn } from "../helpers.mjs";

/**
 * Driver smoke (E10): one trip end to end the way the app drives the API, plus the new endpoints and sync rules —
 * decline, load attestation gating departure, fuel-stop event, idempotent replay of a stop action, out-of-order
 * rejection. Runs against the mock by default; set SMOKE_BASE to point it at apps/api (KEYCLOAK_MODE=stub).
 */
export async function smokeDriver(base, log = console.log) {
  const ctl = client(base);
  const step = (s) => log(`  ✓ ${s}`);
  if (!process.env.SMOKE_BASE) await ctl.post("/__mock/reset");

  const { api, staff } = await signIn(base);
  assert.equal(staff.role, "driver");
  step(`signed in as ${staff.name} (stub OIDC, driver client, budgrub-driver://auth/callback)`);

  // Decline: a second offer goes back to the pool.
  if (!process.env.SMOKE_BASE) {
    const first = (await api.get("/admin/driver/trips")).body.current;
    const dec = await api.post(`/admin/driver/trips/${first.id}/decline`, { reason: "Vehicle problem: smoke test" });
    assert.equal(dec.status, 200);
    assert.equal((await api.get("/admin/driver/trips")).body.current, null);
    step(`declined ${first.number}; trip back in the dispatch pool, decline audited`);
    await ctl.post("/__mock/assign", { driverId: staff.id });
  }

  const offer = (await api.get("/admin/driver/trips")).body;
  const trip = offer.current;
  assert.ok(trip && trip.status === "planned" && trip.manifestLockedAt, "a locked, planned trip is offered");
  assert.ok(trip.flowerEquivG <= trip.capFlowerEquivG, "within cap");
  step(`offer ${trip.number}: ${trip.stops.length} stops, ${trip.flowerEquivG} g of ${trip.capFlowerEquivG} g cap, manifest locked`);

  const dev = device(api, trip.id);
  const early = await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST, floatIssuedCents: 2000 });
  assert.equal(early.body.code, "LOAD_NOT_ATTESTED");
  step("depart refused before the load is attested (LOAD_NOT_ATTESTED)");

  const load = await dev.load({ scans: scansFor(trip), attestation: ATTEST, manifestLockedAt: trip.manifestLockedAt });
  assert.equal(load.status, 201);
  step(`scanned ${load.body.load.scannedTags.length} Metrc packages and attested the sealed load (event #${load.sequence})`);

  const dep = await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST, floatIssuedCents: 2000 });
  assert.equal(dep.status, 200);
  assert.equal(dep.body.status, "departed");
  step("checklist complete, manifest locked, departed with $20.00 float");

  const ping = (lat, lng, t) => ({ lat, lng, speedMps: 11, heading: 45, accuracyM: 8, recordedAt: t });
  assert.equal((await dev.location([ping(36.1263, -115.195, "2026-11-10T23:00:00Z"), ping(36.13, -115.19, "2026-11-10T23:00:10Z")])).status, 202);
  step("GPS batch uploaded");

  const [s1, s2, s3] = trip.stops;
  await dev.stop(s1.orderId, "en-route");
  await dev.stop(s1.orderId, "arrived");
  const phone = await dev.stop(s1.orderId, "phone", { outcome: "confirmed" });
  assert.ok(phone.body.stop.phoneConfirmedAt);
  step(`stop 1 ${s1.orderNumber}: en route → arrived → phone confirmed`);

  // Idempotent replay of a stop action (lost response).
  const replay = await dev.stop(s1.orderId, "phone", { outcome: "confirmed" }, { key: phone.key, sequence: phone.sequence });
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.stop.phoneAttempts.length, 1);
  step("replayed the phone event with the same Idempotency-Key: earlier result returned, not applied twice");

  // Out-of-order rejection and resolution.
  const ooo = await dev.stop(s1.orderId, "id-check", { name: "Jamal Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "5678", expires: "2030-04-02" }, { sequence: dev.seq + 5 });
  assert.equal(ooo.status, 409);
  assert.equal(ooo.body.code, "OUT_OF_ORDER");
  step(`out-of-order event #${ooo.sequence} rejected: OUT_OF_ORDER, server expects #${ooo.body.expectedSequence}`);
  dev.seq = ooo.body.expectedSequence - 1;

  const id = await dev.stop(s1.orderId, "id-check", { name: "Jamal Marcus Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "5678", expires: "2030-04-02", source: "pdf417" });
  assert.equal(id.body.idCheck.ok, true);
  step(`replayed from the gap; ID check passed (#${id.sequence})`);

  const del = await dev.stop(s1.orderId, "deliver", { cashReceivedCents: 6000 });
  assert.equal(del.status, 200);
  assert.equal(del.body.metrc.status, "completed");
  step(`stop 1 delivered: $60.00 cash for $54.00, $6.00 change, Metrc ${del.body.metrc.status}`);

  const fuel = await dev.event({ kind: "fuel_stop", lat: 36.15, lng: -115.175, startedAt: "2026-11-10T23:20:00Z", endedAt: "2026-11-10T23:26:00Z" });
  assert.equal(fuel.status, 201);
  step("fuel stop logged on the trip timeline");

  await dev.stop(s2.orderId, "en-route");
  await dev.stop(s2.orderId, "arrived");
  await dev.stop(s2.orderId, "phone", { outcome: "no_answer" });
  await dev.stop(s2.orderId, "phone", { outcome: "no_answer" });
  await dev.stop(s2.orderId, "phone", { outcome: "no_answer" });
  const ret = await dev.stop(s2.orderId, "return", { reason: "No answer after 3 calls" });
  assert.equal(ret.body.stop.status, "returned");
  step(`stop 2 ${s2.orderNumber} returned after 3 unanswered calls`);

  await dev.stop(s3.orderId, "en-route");
  await dev.stop(s3.orderId, "arrived");
  await dev.stop(s3.orderId, "phone", { outcome: "confirmed" });
  const bad = await dev.stop(s3.orderId, "id-check", { name: "Kevin Smith", dob: "1990-01-01", idType: "drivers_license", expires: "2030-01-01" });
  assert.equal(bad.body.idCheck.ok, false);
  assert.equal((await dev.stop(s3.orderId, "deliver", { cashReceivedCents: 10000 })).body.code, "ID_CHECK_REQUIRED");
  step("stop 3: wrong person's ID fails; hand-over refused server-side");
  await dev.stop(s3.orderId, "id-check", { name: "Alicia Moore", dob: "1988-07-19", idType: "state_id", expires: "2028-07-19" });
  assert.equal((await dev.stop(s3.orderId, "deliver", { cashReceivedCents: 10000 })).status, 200);
  step("stop 3: correct ID passes, delivered with exact cash");

  const cur = (await api.get("/admin/driver/trips")).body.current;
  const done = await api.post(`/admin/dispatch/trips/${trip.id}/complete`, { floatReturnedCents: cur.floatAvailableCents });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "completed");
  step(`trip completed; cash handed back $${(cur.floatAvailableCents / 100).toFixed(2)} (float $20.00 + $154.00 collected)`);

  if (!process.env.SMOKE_BASE) {
    const tl = (await api.get(`/admin/dispatch/trips/${trip.id}/timeline`)).body;
    assert.ok(tl.timeline.some((e) => e.kind === "fuel_stop"));
    assert.equal(tl.trace.length, 2);
    step(`timeline has ${tl.timeline.length} entries and ${tl.trace.length} GPS points`);
  }
}
