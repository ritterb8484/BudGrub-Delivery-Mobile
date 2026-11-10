import { EventQueue, MemoryQueueStore, tripScope, type QueuedEvent, type SendResult, type Sender } from "@/sync/queue";

/** A fake server with the same rules as the API: idempotent per event id, strict per-trip sequence. */
function fakeServer(opts: { lastSeq?: number; reject?: (e: QueuedEvent) => string | null } = {}) {
  const processed = new Map<string, SendResult>();
  const state = { lastSeq: opts.lastSeq ?? 0, calls: [] as { id: string; seq: number }[], down: false };
  const send: Sender = async (e) => {
    state.calls.push({ id: e.id, seq: e.sequence });
    if (state.down) return { kind: "retry", error: "network" };
    const seen = processed.get(e.id);
    if (seen) return seen;
    if (e.sequenced && e.sequence !== state.lastSeq + 1) return { kind: "out_of_order", expected: state.lastSeq + 1 };
    if (e.sequenced) state.lastSeq = e.sequence;
    const why = opts.reject?.(e) ?? null;
    const r: SendResult = why ? { kind: "rejected", status: 422, code: why, message: why, body: { error: why } } : { kind: "ok", status: 200, body: { ok: true, seq: e.sequence } };
    processed.set(e.id, r);
    return r;
  };
  return { send, state, processed };
}

let n = 0;
const uuid = () => `evt-${++n}`;
const scope = tripScope("t1");

function make() {
  const store = new MemoryQueueStore();
  const q = new EventQueue(store, { uuid });
  const add = (body: Record<string, unknown> = {}, path = "/x") => q.enqueue({ scope, kind: "stop_action", path, body });
  return { store, q, add };
}

describe("EventQueue", () => {
  it("assigns monotonic sequence numbers per scope and persists before any network call", async () => {
    const { q, add } = make();
    const a = await add();
    const b = await add();
    const other = await q.enqueue({ scope: tripScope("t2"), kind: "location", path: "/l", body: {} });
    expect([a.sequence, b.sequence, other.sequence]).toEqual([1, 2, 1]);
    expect((await q.pending()).length).toBe(3);
    expect(a.status).toBe("pending");
    expect(a.deviceTs).toMatch(/\dT\d/);
  });

  it("replays in sequence order and acks each event", async () => {
    const { q, add } = make();
    for (let i = 0; i < 5; i++) await add({ i });
    const srv = fakeServer();
    const r = await q.drain(srv.send);
    expect(r).toMatchObject({ sent: 5, stoppedBy: null });
    expect(srv.state.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await q.pending()).length).toBe(0);
    expect((await q.list(scope)).every((e) => e.status === "acked" && e.ackedAt)).toBe(true);
  });

  it("stops on a transport failure, keeps order, and resumes from the same event", async () => {
    const { q, add } = make();
    for (let i = 0; i < 3; i++) await add();
    const srv = fakeServer();
    srv.state.down = true;
    const r1 = await q.drain(srv.send);
    expect(r1.stoppedBy).toBe("retry");
    expect((await q.pending()).length).toBe(3);
    expect((await q.list(scope))[0].attempts).toBe(1);
    srv.state.down = false;
    const r2 = await q.drain(srv.send);
    expect(r2.sent).toBe(3);
    expect(srv.state.calls.filter((c) => c.seq !== 1 || true).slice(1).map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it("is safe to replay an event the server already processed (lost response)", async () => {
    const { q, add } = make();
    const a = await add();
    const srv = fakeServer();
    // Server processes it, but the device never hears back.
    await srv.send(a);
    const r = await q.drain(srv.send);
    expect(r.sent).toBe(1);
    expect(srv.state.lastSeq).toBe(1);
    expect(srv.processed.size).toBe(1);
  });

  it("replays from the gap when the server is missing earlier events", async () => {
    const { q, add, store } = make();
    for (let i = 0; i < 4; i++) await add();
    const srv = fakeServer();
    await q.drain(srv.send);
    // Server loses events 3 and 4 (e.g. restored from backup); device adds 5.
    srv.state.lastSeq = 2;
    for (const id of [...srv.processed.keys()].slice(2)) srv.processed.delete(id);
    await add();
    const r = await q.drain(srv.send);
    expect(r.replayedFromGap).toBe(2);
    expect(r.stoppedBy).toBeNull();
    expect(srv.state.lastSeq).toBe(5);
    expect((await store.listScope(scope)).map((e) => e.status)).toEqual(["acked", "acked", "acked", "acked", "acked"]);
  });

  it("reports an unresolvable gap when the device no longer holds the missing events", async () => {
    const { q, add } = make();
    await add();
    await add();
    const srv = fakeServer();
    await q.drain(srv.send);
    await q.purge(scope); // trip closed locally, events gone
    await add(); // sequence 3 (counter survives purge)
    srv.state.lastSeq = 1;
    srv.processed.clear();
    const r = await q.drain(srv.send);
    expect(r.stoppedBy).toBe("gap_unresolvable");
    expect((await q.pending()).length).toBe(1);
  });

  it("rebases pending events when the server is ahead of the device counter", async () => {
    const { q, add } = make();
    await add({ a: 1 });
    await add({ a: 2 });
    const srv = fakeServer({ lastSeq: 10 }); // e.g. app reinstalled mid-trip
    const r = await q.drain(srv.send);
    expect(r.rebased).toBe(2);
    expect(r.sent).toBe(2);
    const events = await q.list(scope);
    expect(events.map((e) => [e.sequence, e.body.a])).toEqual([[11, 1], [12, 2]]);
    const next = await add();
    expect(next.sequence).toBe(13);
  });

  it("marks business rejections and keeps draining (the server consumed the sequence)", async () => {
    const { q, add } = make();
    await add({ action: "arrived" });
    await add({ action: "deliver" });
    await add({ action: "return" });
    const srv = fakeServer({ reject: (e) => (e.body.action === "deliver" ? "ID_CHECK_REQUIRED" : null) });
    const r = await q.drain(srv.send);
    expect(r).toMatchObject({ sent: 2, rejected: 1, stoppedBy: null });
    const events = await q.list(scope);
    expect(events[1].status).toBe("rejected");
    expect(events[1].lastError).toContain("ID_CHECK_REQUIRED");
  });

  it("stops every scope on 401 and leaves events pending", async () => {
    const { q, add } = make();
    await add();
    await q.enqueue({ scope: "incidents", kind: "incident", path: "/admin/incidents", body: {} });
    const r = await q.drain(async () => ({ kind: "unauthorized" }));
    expect(r.stoppedBy).toBe("unauthorized");
    expect((await q.pending()).length).toBe(2);
  });

  it("does not enforce sequence on unsequenced scopes", async () => {
    const store = new MemoryQueueStore();
    const q = new EventQueue(store, { uuid });
    const e = await q.enqueue({ scope: "incidents", kind: "incident", path: "/admin/incidents", body: {} });
    expect(e.sequenced).toBe(false);
    const srv = fakeServer({ lastSeq: 99 });
    expect((await q.drain(srv.send)).sent).toBe(1);
  });

  it("redacts sensitive fields once acknowledged", async () => {
    const store = new MemoryQueueStore();
    const q = new EventQueue(store, {
      uuid,
      redactOnAck: (e) => (e.meta.action === "id-check" ? { idType: e.body.idType, last4: e.body.last4, dobYear: String(e.body.dob).slice(0, 4) } : null),
    });
    await q.enqueue({ scope, kind: "stop_action", path: "/id", body: { name: "Jamal Pierce", dob: "1990-04-02", idType: "drivers_license", last4: "1234" }, meta: { action: "id-check" } });
    await q.drain(fakeServer().send);
    const [e] = await q.list(scope);
    expect(e.body).toEqual({ idType: "drivers_license", last4: "1234", dobYear: "1990" });
  });

  it("shares one in-flight drain between concurrent callers", async () => {
    const { q, add } = make();
    await add();
    const srv = fakeServer();
    const [a, b] = await Promise.all([q.drain(srv.send), q.drain(srv.send)]);
    expect(a).toBe(b);
    expect(srv.state.calls.length).toBe(1);
  });
});
