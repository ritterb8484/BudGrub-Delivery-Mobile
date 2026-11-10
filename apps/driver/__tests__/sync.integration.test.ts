/// <reference types="node" />
/**
 * Runs in the `integration` Jest project (plain Node environment). The app's queue + HTTP sender against the mock API (apps/mock-api) in a child process: ordered replay after an
 * outage, idempotent re-send after a lost response, server rejection consuming the sequence, and the gap / rebase
 * resolutions of OUT_OF_ORDER — over real HTTP with the same Idempotency-Key and sequence the device sends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventQueue, MemoryQueueStore, tripScope } from "@/sync/queue";
import { createHttpSender, type Poster } from "@/sync/sender";

const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/api`;
let proc: ChildProcess;
let token = "";
let online = true;

const call = async (p: string, body?: unknown, bearer = token, method = body === undefined ? "GET" : "POST") => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t && r.headers.get("content-type")?.includes("json") ? JSON.parse(t) : t };
};

async function signIn() {
  const s = (await call("/session", {}, "")).body.token;
  const start = (await call("/auth/start", { client: "driver", redirectUri: "budgrub-driver://auth/callback" }, s)).body;
  const page = await (await fetch(start.url)).text();
  const href = /<a class="u" href="([^"]+)"><b>Jamal Pierce/.exec(page)![1];
  const u = new URL(href.replace("budgrub-driver://", "http://x/"));
  return (await call("/auth/callback", { code: u.searchParams.get("code"), state: u.searchParams.get("state") }, s)).body.token as string;
}

const post: Poster = async (p, body, headers) => {
  if (!online) throw new Error("Network request failed");
  return fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
};
const sender = createHttpSender(post, { hasToken: () => Boolean(token) });

beforeAll(async () => {
  proc = spawn(process.execPath, [path.resolve(__dirname, "../../mock-api/src/index.mjs")], { env: { ...process.env, PORT: String(PORT), EXPORTS_DIR: path.join(tmpdir(), "budgrub-it") }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/__mock/state`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}, 15_000);
afterAll(() => {
  proc?.kill();
});

let tripId = "";
let stops: { orderId: string; items: { metrcTag: string }[] }[] = [];
const checklist = { agent_card: true, approved_vehicle: true, inspection_card: true, alarm: true, lockbox: true, no_passengers: true };

async function freshDepartedTrip(queue: EventQueue) {
  await call("/__mock/reset", {}, "");
  token = await signIn();
  const t = (await call("/admin/driver/trips")).body.current;
  tripId = t.id;
  stops = t.stops;
  const scans = stops.flatMap((s) => s.items.map((i) => ({ tag: i.metrcTag, result: "matched", at: new Date().toISOString() })));
  await queue.enqueue({ scope: tripScope(tripId), kind: "load", path: `/admin/driver/trips/${tripId}/load`, body: { scans, attestation: { sealed: true, notVisible: true, lockbox: true }, manifestLockedAt: t.manifestLockedAt } });
  const r = await queue.drain(sender);
  expect(r.sent).toBe(1);
  expect((await call(`/admin/dispatch/trips/${tripId}/depart`, { checklist, floatIssuedCents: 2000 })).status).toBe(200);
}

const stopPath = (orderId: string, action: string) => `/admin/dispatch/trips/${tripId}/stops/${orderId}/${action}`;

describe("queue ↔ API (integration)", () => {
  it("queues offline and replays in order on reconnect", async () => {
    const q = new EventQueue(new MemoryQueueStore(), { uuid: randomUUID });
    await freshDepartedTrip(q);
    const s1 = stops[0].orderId;
    online = false;
    for (const [action, body] of [["en-route", {}], ["arrived", {}], ["phone", { outcome: "confirmed" }], ["id-check", { name: "Jamal Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "5678", expires: "2030-04-02" }], ["deliver", { cashReceivedCents: 5400 }]] as const) {
      await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, action), body: { ...body } });
    }
    const offline = await q.drain(sender);
    expect(offline.stoppedBy).toBe("retry");
    expect((await q.pending()).length).toBe(5);
    online = true;
    const r = await q.drain(sender);
    expect(r).toMatchObject({ sent: 5, rejected: 0, stoppedBy: null });
    const trip = (await call("/admin/driver/trips")).body.current;
    expect(trip.stops[0].status).toBe("delivered");
    expect(trip.lastSequence).toBe(6);
    const deliver = (await q.list(tripScope(tripId))).at(-1)!;
    expect((deliver.response as { metrc: { status: string } }).metrc.status).toBe("completed");
  });

  it("re-sends after a lost response without applying twice", async () => {
    const q = new EventQueue(new MemoryQueueStore(), { uuid: randomUUID });
    await freshDepartedTrip(q);
    const s1 = stops[0].orderId;
    await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "en-route"), body: {} });
    await q.drain(sender);
    const e = await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "arrived"), body: {} });
    // Deliver the request but drop the response.
    let dropped = false;
    const lossy = createHttpSender(async (p, b, h) => {
      const res = await post(p, b, h);
      if (!dropped) {
        dropped = true;
        throw new Error("socket hang up");
      }
      return res;
    }, { hasToken: () => true });
    expect((await q.drain(lossy)).stoppedBy).toBe("retry");
    const r = await q.drain(lossy);
    expect(r.sent).toBe(1);
    expect(((await q.get(e.scope, e.id))!.response as { replayed?: boolean }).replayed).toBe(true);
  });

  it("marks a server rejection and keeps the trip queue moving", async () => {
    const q = new EventQueue(new MemoryQueueStore(), { uuid: randomUUID });
    await freshDepartedTrip(q);
    const s1 = stops[0].orderId;
    await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "en-route"), body: {} });
    await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "arrived"), body: {} });
    await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "deliver"), body: { cashReceivedCents: 5400 } });
    await q.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(s1, "phone"), body: { outcome: "confirmed" } });
    const r = await q.drain(sender);
    expect(r).toMatchObject({ sent: 3, rejected: 1, stoppedBy: null });
    const rejected = (await q.list(tripScope(tripId))).find((x) => x.status === "rejected")!;
    expect(rejected.lastError).toMatch(/PHONE_NOT_CONFIRMED/);
  });

  it("rebases when the server is ahead (reinstall) and replays from the gap when it is behind", async () => {
    const q1 = new EventQueue(new MemoryQueueStore(), { uuid: randomUUID });
    await freshDepartedTrip(q1); // server lastSequence = 1
    // A reinstalled app starts numbering again at 1.
    const q2 = new EventQueue(new MemoryQueueStore(), { uuid: randomUUID });
    await q2.enqueue({ scope: tripScope(tripId), kind: "location", path: `/admin/driver/trips/${tripId}/location`, body: { pings: [{ lat: 36.13, lng: -115.19, speedMps: 0, heading: null, accuracyM: 9, recordedAt: new Date().toISOString() }] } });
    const r = await q2.drain(sender);
    expect(r).toMatchObject({ rebased: 1, sent: 1, stoppedBy: null });
    expect((await q2.list(tripScope(tripId)))[0].sequence).toBe(2);

    // Behind: the device skips ahead (e.g. a lost local write); the server asks for 3 and the queue has it.
    const store = new MemoryQueueStore();
    const q3 = new EventQueue(store, { uuid: randomUUID });
    await store.bumpSequence(tripScope(tripId), 3);
    const a = await q3.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(stops[0].orderId, "en-route"), body: {} });
    const b = await q3.enqueue({ scope: tripScope(tripId), kind: "stop_action", path: stopPath(stops[0].orderId, "arrived"), body: {} });
    expect([a.sequence, b.sequence]).toEqual([3, 4]);
    await store.update(a.id, { status: "acked" }); // device believes 3 was sent; server never got it
    const g = await q3.drain(sender);
    expect(g).toMatchObject({ replayedFromGap: 1, sent: 2, stoppedBy: null });
    expect((await call("/admin/driver/trips")).body.current.stops[0].status).toBe("arrived");
  });
});
