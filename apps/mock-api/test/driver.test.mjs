import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { ALL_CHECKLIST, ATTEST, client, device, scansFor, signIn, start } from "./helpers.mjs";

let srv;
let api;
let trip;
let dev;

before(async () => {
  srv = await start();
});
after(() => srv.close());

beforeEach(async () => {
  await client(srv.base).post("/__mock/reset");
  ({ api } = await signIn(srv.base));
  trip = (await api.get("/admin/driver/trips")).body.current;
  dev = device(api, trip.id);
});

async function loadAndDepart(floatIssuedCents = 2000) {
  const l = await dev.load({ scans: scansFor(trip), attestation: ATTEST, manifestLockedAt: trip.manifestLockedAt });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  const d = await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST, floatIssuedCents });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  return d.body;
}

describe("identity (third OIDC client)", () => {
  it("signs the driver in through the stub flow with the driver redirect URI", async () => {
    const me = await api.get("/admin/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.name, "Jamal Pierce");
    assert.equal(me.body.role, "driver");
  });
  it("refuses an unregistered redirect URI for the driver client", async () => {
    const anon = client(srv.base);
    const { body } = await anon.post("/session");
    const r = await anon.withToken(body.token).post("/auth/start", { client: "driver", redirectUri: "evil://callback" });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "REDIRECT_NOT_ALLOWED");
  });
  it("revokes the token on logout (401 afterwards)", async () => {
    assert.equal((await api.post("/admin/logout")).status, 204);
    assert.equal((await api.get("/admin/me")).status, 401);
  });
  it("registers and deregisters a push device", async () => {
    assert.equal((await api.post("/admin/driver/devices", { platform: "ios", token: "apns-123" })).status, 204);
    assert.equal((await client(srv.base).get("/__mock/state")).body.devices.length, 1);
    assert.equal((await api.del("/admin/driver/devices", { platform: "ios", token: "apns-123" })).status, 204);
    assert.equal((await client(srv.base).get("/__mock/state")).body.devices.length, 0);
  });
});

describe("POST /admin/driver/trips/:id/decline", () => {
  it("returns the trip to the dispatch pool and audits the decline on the driver record", async () => {
    const r = await api.post(`/admin/driver/trips/${trip.id}/decline`, { reason: "Vehicle problem: flat tyre" });
    assert.equal(r.status, 200);
    assert.equal((await api.get("/admin/driver/trips")).body.current, null);
    const st = (await client(srv.base).get("/__mock/state")).body;
    assert.deepEqual(st.pool, [trip.id]);
    assert.equal(st.declines[0].staffId, "stf_jamal");
    assert.equal(st.declines[0].reason, "Vehicle problem: flat tyre");
  });
  it("requires a reason and only applies to planned trips", async () => {
    assert.equal((await api.post(`/admin/driver/trips/${trip.id}/decline`, { reason: "" })).body.code, "REASON_REQUIRED");
    await loadAndDepart();
    assert.equal((await api.post(`/admin/driver/trips/${trip.id}/decline`, { reason: "too late" })).body.code, "TRIP_NOT_DECLINABLE");
  });
});

describe("load attestation gates departure", () => {
  it("refuses depart before the load is attested", async () => {
    const d = await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST, floatIssuedCents: 0 });
    assert.equal(d.status, 409);
    assert.equal(d.body.code, "LOAD_NOT_ATTESTED");
  });
  it("rejects a load with a missing or stray package", async () => {
    const scans = scansFor(trip).slice(1).concat([{ tag: "1A4060300003B01000099999", result: "matched" }]);
    const r = await dev.load({ scans, attestation: ATTEST });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "LOAD_MISMATCH");
    assert.deepEqual(r.body.unknown, ["1A4060300003B01000099999"]);
    assert.equal(r.body.missing.length, 1);
  });
  it("rejects an incomplete attestation and a stale manifest", async () => {
    assert.equal((await dev.load({ scans: scansFor(trip), attestation: { ...ATTEST, lockbox: false } })).body.code, "ATTESTATION_INCOMPLETE");
    assert.equal((await dev.load({ scans: scansFor(trip), attestation: ATTEST, manifestLockedAt: "2020-01-01T00:00:00Z" })).body.code, "MANIFEST_CHANGED");
  });
  it("departs once the load is attested and the checklist is complete; a re-issued manifest clears the load", async () => {
    await dev.load({ scans: scansFor(trip), attestation: ATTEST });
    const partial = await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: { ...ALL_CHECKLIST, alarm: false } });
    assert.equal(partial.body.code, "CHECKLIST_INCOMPLETE");
    await client(srv.base).post(`/__mock/trips/${trip.id}/reissue-manifest`);
    assert.equal((await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST })).body.code, "LOAD_NOT_ATTESTED");
    trip = (await api.get("/admin/driver/trips")).body.current;
    const t = await loadAndDepart();
    assert.equal(t.status, "departed");
    assert.ok(t.load.attestedAt);
  });
  it("stores the sealed-load photo in evidence storage", async () => {
    const photo = { mime: "image/jpeg", dataBase64: Buffer.from("fake-jpeg").toString("base64") };
    const r = await dev.load({ scans: scansFor(trip), attestation: ATTEST, photo });
    assert.equal(r.status, 201);
    assert.match(r.body.load.photoUrl, /^\/evidence\/trp_\d+\/load-/);
    assert.equal(readdirSync(`${srv.state.evidenceDir}/${trip.id}`).length, 1);
  });
  it("refuses departure while Metrc is degraded without a manual manifest", async () => {
    await dev.load({ scans: scansFor(trip), attestation: ATTEST });
    await client(srv.base).post("/__mock/metrc", { degraded: true });
    assert.equal((await api.post(`/admin/dispatch/trips/${trip.id}/depart`, { checklist: ALL_CHECKLIST })).body.code, "METRC_DEGRADED");
  });
});

describe("idempotency and ordering", () => {
  it("replays a stop action idempotently: same result, applied once", async () => {
    await loadAndDepart();
    const s1 = trip.stops[0].orderId;
    await dev.stop(s1, "en-route");
    await dev.stop(s1, "arrived");
    const first = await dev.stop(s1, "phone", { outcome: "no_answer" });
    const replay = await dev.stop(s1, "phone", { outcome: "no_answer" }, { key: first.key, sequence: first.sequence });
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.stop.phoneAttempts, first.body.stop.phoneAttempts);
    const now = (await api.get("/admin/driver/trips")).body.current;
    assert.equal(now.stops[0].phoneAttempts.length, 1);
    assert.equal(now.lastSequence, 4);
  });
  it("rejects an out-of-order sequence with OUT_OF_ORDER and the expected number", async () => {
    await loadAndDepart(); // seq 1
    const r = await dev.stop(trip.stops[0].orderId, "en-route", {}, { sequence: 3 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "OUT_OF_ORDER");
    assert.equal(r.body.expectedSequence, 2);
    // Resolving by replaying from the gap succeeds.
    assert.equal((await dev.stop(trip.stops[0].orderId, "en-route", {}, { sequence: 2 })).status, 200);
  });
  it("a business rejection consumes the sequence so the queue can move on", async () => {
    await loadAndDepart();
    const s1 = trip.stops[0].orderId;
    await dev.stop(s1, "en-route");
    await dev.stop(s1, "arrived");
    const refused = await dev.stop(s1, "deliver", { cashReceivedCents: 5400 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "PHONE_NOT_CONFIRMED");
    const next = await dev.stop(s1, "phone", { outcome: "confirmed" });
    assert.equal(next.status, 200);
    assert.equal(next.sequence, refused.sequence + 1);
    // Replaying the refused event returns the same refusal, without re-running it.
    const again = await dev.stop(s1, "deliver", { cashReceivedCents: 5400 }, { key: refused.key, sequence: refused.sequence });
    assert.equal(again.status, 409);
    assert.equal(again.body.replayed, true);
  });
  it("requires Idempotency-Key when a sequence is sent", async () => {
    await loadAndDepart();
    const r = await api.post(`/admin/dispatch/trips/${trip.id}/stops/${trip.stops[0].orderId}/en-route`, { sequence: 2 });
    assert.equal(r.body.code, "IDEMPOTENCY_KEY_REQUIRED");
  });
  it("keeps the legacy web console path (no key, no sequence) working", async () => {
    await loadAndDepart();
    const r = await api.post(`/admin/dispatch/trips/${trip.id}/stops/${trip.stops[0].orderId}/en-route`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.stop.status, "en_route");
  });
  it("does not duplicate GPS pings on replay", async () => {
    await loadAndDepart();
    const pings = [{ lat: 36.13, lng: -115.19, speedMps: 12, heading: 90, accuracyM: 8, recordedAt: "2026-11-10T23:01:00Z" }];
    const a = await dev.location(pings);
    await dev.location(pings, { key: a.key, sequence: a.sequence });
    assert.equal((await client(srv.base).get("/__mock/state")).body.traces[trip.id], 1);
  });
  it("makes incidents idempotent per key", async () => {
    const body = { kind: "crash", description: "Rear-ended at a light", location: "Sahara & Rancho", packages: [], policeReportNumber: null, injuries: false, tripId: trip.id };
    const a = await api.post("/admin/incidents", body, { "Idempotency-Key": "inc-1" });
    const b = await api.post("/admin/incidents", body, { "Idempotency-Key": "inc-1" });
    assert.equal(a.status, 201);
    assert.equal(b.body.number, a.body.number);
    assert.equal((await client(srv.base).get("/__mock/state")).body.incidents.length, 1);
  });
});

describe("hand-over rules", () => {
  it("enforces 21+, expiry and name match server-side and refuses hand-over without a passing ID check", async () => {
    await loadAndDepart();
    const s1 = trip.stops[0].orderId;
    await dev.stop(s1, "en-route");
    await dev.stop(s1, "arrived");
    await dev.stop(s1, "phone", { outcome: "confirmed" });
    const young = await dev.stop(s1, "id-check", { name: "Jamal Pierce", dob: "2006-01-01", idType: "drivers_license", last4: "5678", expires: "2030-01-01" });
    assert.equal(young.body.idCheck.ok, false);
    assert.equal(young.body.idCheck.reasons[0].code, "UNDER_AGE");
    assert.equal((await dev.stop(s1, "deliver", { cashReceivedCents: 6000 })).body.code, "ID_CHECK_REQUIRED");
    const close = await dev.stop(s1, "id-check", { name: "Jamall Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "5678", expires: "2030-04-02" });
    assert.equal(close.body.idCheck.reasons[0].code, "NAME_MISMATCH");
    const confirmed = await dev.stop(s1, "id-check", { name: "Jamall Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "5678", expires: "2030-04-02", nameConfirmed: true });
    assert.equal(confirmed.body.idCheck.ok, true);
    // Only pass/fail, reasons, document type, last 4, DOB year are logged.
    const log = confirmed.body.stop.idChecks.at(-1);
    assert.deepEqual(Object.keys(log).sort(), ["agent", "at", "dobYear", "idType", "last4", "ok", "reasons", "source"]);
    assert.equal(log.dobYear, 1990);
    const d = await dev.stop(s1, "deliver", { cashReceivedCents: 6000 });
    assert.equal(d.status, 200);
    assert.equal(d.body.metrc.status, "completed");
    assert.equal((await api.get("/admin/driver/trips")).body.current.floatAvailableCents, 2000 + 5400);
  });
  it("refuses change larger than the float", async () => {
    await loadAndDepart(0);
    const s1 = trip.stops[0].orderId;
    for (const [a, b] of [["en-route"], ["arrived"], ["phone", { outcome: "confirmed" }], ["id-check", { name: "Jamal Pierce", dob: "1990-04-02", idType: "drivers_license", expires: "2030-01-01" }]]) await dev.stop(s1, a, b);
    assert.equal((await dev.stop(s1, "deliver", { cashReceivedCents: 10000 })).body.code, "CHANGE_EXCEEDS_FLOAT");
  });
  it("blocks stop actions until a plan amendment is acknowledged", async () => {
    await loadAndDepart();
    await client(srv.base).post(`/__mock/trips/${trip.id}/amend-plan`);
    const r = await dev.stop(trip.stops[0].orderId, "en-route");
    assert.equal(r.body.code, "PLAN_NOT_ACKNOWLEDGED");
    assert.equal((await api.post(`/admin/driver/trips/${trip.id}/ack-plan`, { version: 2 })).status, 200);
    const now = (await api.get("/admin/driver/trips")).body.current;
    const first = now.stops.find((s) => s.seq === 1);
    assert.equal((await dev.stop(first.orderId, "en-route")).status, 200);
  });
});

describe("POST /admin/driver/trips/:id/events", () => {
  it("records a fuel stop with receipt photo on the trip timeline", async () => {
    await loadAndDepart();
    const r = await dev.event({ kind: "fuel_stop", lat: 36.14, lng: -115.16, startedAt: "2026-11-10T23:10:00Z", endedAt: "2026-11-10T23:16:00Z", photo: { mime: "image/jpeg", dataBase64: "AAAA" } });
    assert.equal(r.status, 201);
    assert.match(r.body.event.receiptUrl, /receipt-/);
    const tl = (await api.get(`/admin/dispatch/trips/${trip.id}/timeline`)).body.timeline;
    assert.ok(tl.some((e) => e.kind === "fuel_stop" && e.startedAt === "2026-11-10T23:10:00Z"));
  });
  it("validates kind and times", async () => {
    await loadAndDepart();
    assert.equal((await dev.event({ kind: "nap" })).body.code, "UNKNOWN_EVENT");
    assert.equal((await dev.event({ kind: "fuel_stop", startedAt: "x" })).body.code, "TIMES_REQUIRED");
  });
});

describe("trip close", () => {
  it("requires every stop to be settled", async () => {
    await loadAndDepart();
    assert.equal((await api.post(`/admin/dispatch/trips/${trip.id}/complete`, { floatReturnedCents: 2000 })).body.code, "STOPS_OPEN");
  });
});
