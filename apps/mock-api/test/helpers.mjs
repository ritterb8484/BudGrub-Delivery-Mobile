import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createState } from "../src/server.mjs";

/** Start the mock API on a free port. `now` is injectable so ID age rules are deterministic. */
export async function start({ now = () => new Date(2026, 10, 10, 15, 0, 0) } = {}) {
  const state = createState(now);
  state.evidenceDir = mkdtempSync(join(tmpdir(), "budgrub-evidence-"));
  const { server } = createServer(state);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const close = () => new Promise((r) => server.close(r));
  return { base, state, close };
}

export function client(base, token = null) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, body: text && ct.includes("json") ? JSON.parse(text) : text };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b = {}, h) => call("POST", p, b, h),
    del: (p, b = {}, h) => call("DELETE", p, b, h),
    withToken: (t) => client(base, t),
  };
}

/** Full stub OIDC flow as the driver app does it. Returns an authenticated client. */
export async function signIn(base, user = "stub-jamal") {
  const anon = client(base);
  const { body: session } = await anon.post("/session");
  const s = anon.withToken(session.token);
  const start = await s.post("/auth/start", { client: "driver", redirectUri: "budgrub-driver://auth/callback" });
  if (start.status !== 200) throw new Error(`auth/start ${start.status} ${JSON.stringify(start.body)}`);
  const page = await fetch(start.body.url).then((r) => r.text());
  const href = [...page.matchAll(/<a class="u" href="([^"]+)"><b>[^<]+<\/b><span>([^ ]+)/g)].find((m) => m[2] === user)?.[1];
  if (!href) throw new Error(`stub login page has no identity ${user}`);
  const u = new URL(href.replace("budgrub-driver://", "http://x/"));
  const cb = await s.post("/auth/callback", { code: u.searchParams.get("code"), state: u.searchParams.get("state") });
  if (cb.status !== 200) throw new Error(`auth/callback ${cb.status}`);
  return { api: client(base, cb.body.token), staff: cb.body.staff, token: cb.body.token };
}

/** Device-style event poster: Idempotency-Key + monotonic sequence per trip. */
export function device(api, tripId) {
  let seq = 0;
  const send = (path, body, { key = randomUUID(), sequence } = {}) => {
    const s = sequence ?? ++seq;
    return api.post(path, { ...body, sequence: s, deviceTs: new Date().toISOString() }, { "Idempotency-Key": key }).then((r) => ({ ...r, key, sequence: s }));
  };
  return {
    send,
    stop: (orderId, action, body = {}, o) => send(`/admin/dispatch/trips/${tripId}/stops/${orderId}/${action}`, body, o),
    load: (body, o) => send(`/admin/driver/trips/${tripId}/load`, body, o),
    event: (body, o) => send(`/admin/driver/trips/${tripId}/events`, body, o),
    location: (pings, o) => send(`/admin/driver/trips/${tripId}/location`, { pings }, o),
    get seq() {
      return seq;
    },
    set seq(v) {
      seq = v;
    },
  };
}

export const ALL_CHECKLIST = { agent_card: true, approved_vehicle: true, inspection_card: true, alarm: true, lockbox: true, no_passengers: true };

export function scansFor(trip) {
  return trip.stops.flatMap((s) => s.items.map((i) => ({ tag: i.metrcTag, at: new Date().toISOString(), result: "matched" })));
}

export const ATTEST = { sealed: true, notVisible: true, lockbox: true, attestedAt: "2026-11-10T22:55:00.000Z" };
