import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { CHECKLIST, ID_TYPES, seedTrip, STAFF } from "./seed.mjs";

/**
 * BudGrub mock API for the driver app. Implements the existing driver endpoints the way the prompt and the web console
 * describe them, plus the new endpoints and rules the native app needs (decline, load attestation gating departure,
 * trip events, Idempotency-Key + sequence with OUT_OF_ORDER). It is the executable reference for the server changes in
 * docs/driver-api-changes.md — not a replacement for apps/api.
 *
 * Legacy compatibility: a request with neither `Idempotency-Key` nor `sequence` (the web driver console) is processed
 * without idempotency or ordering, exactly as today.
 */

const REDIRECTS = { admin: ["http://localhost:5174/auth/callback"], web: ["http://localhost:5173/auth/callback"], driver: ["budgrub-driver://auth/callback"] };
const MIN_AGE = 21;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const REPLY = Symbol("reply");
/** Explicit status + body response (anything else a handler returns is sent as 200 JSON). */
const reply = (status, body) => ({ [REPLY]: true, status, body });

const tok = (p) => `${p}_${randomBytes(18).toString("base64url")}`;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Server-side ID rules (the device repeats them for immediate feedback). */
export function checkId(body, recipient, now) {
  const reasons = [];
  const today = localDate(now);
  if (!ID_TYPES.includes(body.idType)) reasons.push({ code: "ID_TYPE_NOT_ACCEPTED", message: "ID type is not accepted." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dob ?? "")) reasons.push({ code: "DOB_INVALID", message: "Date of birth is not valid." });
  else {
    const [by, bm, bd] = body.dob.split("-").map(Number);
    const [ty, tm, td] = today.split("-").map(Number);
    let age = ty - by;
    if (tm < bm || (tm === bm && td < bd)) age--;
    if (age < MIN_AGE) reasons.push({ code: "UNDER_AGE", message: `Customer is ${age}. They must be ${MIN_AGE} or older.` });
  }
  if (!body.expires) reasons.push({ code: "EXPIRY_MISSING", message: "Expiry date is required." });
  else if (body.expires < today) reasons.push({ code: "ID_EXPIRED", message: `ID expired on ${body.expires}.` });
  const a = norm(body.name), b = norm(recipient);
  const same = a.length && b.length && a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
  const close = a.length && b.length && editDistance(a[0], b[0]) <= 2 && (editDistance(a[a.length - 1], b[b.length - 1]) <= 2 || a.slice(1).some((t) => b.slice(1).includes(t)));
  if (!same && !(close && body.nameConfirmed === true)) reasons.push({ code: "NAME_MISMATCH", message: `Name on ID does not match ${recipient}.` });
  return { ok: reasons.length === 0, reasons };
}

export function createState(now = () => new Date()) {
  const trip = seedTrip(now());
  return {
    now,
    sessions: new Set(),
    pendingAuth: new Map(), // state → { client, redirectUri }
    codes: new Map(), // code → stub user key
    tokens: new Map(), // bearer → stub user key
    devices: [],
    trips: [trip],
    pool: [], // declined trips back in the dispatch pool
    declines: [], // audited on the driver record
    plans: { [trip.id]: [{ version: 1, at: now().toISOString(), stops: trip.stops.map((s) => s.orderId), reason: "Initial plan" }] },
    timeline: { [trip.id]: [] },
    traces: { [trip.id]: [] },
    processed: new Map(), // `${tripId|scope}:${key}` → { status, body }
    incidents: [],
    metrcDegraded: false,
    enforceHours: false,
    evidenceDir: process.env.EXPORTS_DIR || join(process.cwd(), ".data", "evidence"),
  };
}

function view(trip) {
  // Cash on hand: float plus cash kept (order totals of delivered cash stops), i.e. received minus change given.
  const kept = trip.stops.filter((s) => s.status === "delivered" && s.paymentMethod === "cash" && s.settledMethod !== "aeropay_door").reduce((n, s) => n + s.totalCents, 0);
  const cashExpectedCents = trip.stops.filter((s) => s.paymentMethod === "cash" && s.status !== "cancelled").reduce((n, s) => n + s.totalCents, 0);
  const { driverId, lastSequence, ...rest } = trip;
  return { ...rest, cashExpectedCents, floatAvailableCents: trip.floatIssuedCents + kept, lastSequence };
}

function agentSummary(staff) {
  return { name: staff.name, agentCardNumber: staff.agent?.agentCardNumber ?? null, agentCardExpires: staff.agent?.agentCardExpires ?? null, problems: staff.agent?.problems ?? (staff.agent ? [] : ["No agent card on file"]) };
}

export function createApp(state = createState()) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
    routes.push({ method, re, keys, handler });
  };

  const staffFor = (req) => {
    const h = req.headers.authorization ?? "";
    const key = state.tokens.get(h.replace(/^Bearer /, ""));
    if (!key) throw new HttpError(401, "UNAUTHORIZED", "Sign in again.");
    const staff = STAFF[key];
    if (staff.status !== "active") throw new HttpError(401, "SUSPENDED", "Your account is suspended.");
    return staff;
  };
  const driver = (req) => {
    const s = staffFor(req);
    if (s.role !== "driver") throw new HttpError(403, "FORBIDDEN", "Driver role required.");
    return s;
  };
  const tripOf = (staff, id) => {
    const t = state.trips.find((x) => x.id === id && x.driverId === staff.id);
    if (!t) throw new HttpError(404, "TRIP_NOT_FOUND", "Trip not found.");
    return t;
  };
  const stopOf = (trip, orderId) => {
    const s = trip.stops.find((x) => x.orderId === orderId);
    if (!s) throw new HttpError(404, "STOP_NOT_FOUND", "Stop not found.");
    return s;
  };

  /**
   * Idempotency + ordering for device events (BUD-124).
   *  - Idempotency-Key seen before for this trip → the stored response, `replayed: true`, nothing re-applied.
   *  - `sequence` must be lastSequence + 1, else 409 OUT_OF_ORDER { expectedSequence }.
   *  - A 2xx or 4xx outcome consumes the sequence and is stored; 5xx does not.
   *  - Neither header nor sequence: legacy (web console) path, processed as before.
   */
  const eventful = (scopeKey, trip, req, body, fn) => {
    const key = req.headers["idempotency-key"];
    const seq = body?.sequence;
    if (!key && seq === undefined) {
      const r = fn();
      return r?.[REPLY] ? r : reply(r.status, r.body);
    }
    if (!key) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required with sequence.");
    const pk = `${scopeKey}:${key}`;
    const prior = state.processed.get(pk);
    if (prior) return reply(prior.status, { ...prior.body, replayed: true });
    if (trip && seq !== undefined) {
      if (!Number.isInteger(seq) || seq < 1) throw new HttpError(400, "SEQUENCE_INVALID", "sequence must be a positive integer.");
      const expected = trip.lastSequence + 1;
      if (seq !== expected) throw new HttpError(409, "OUT_OF_ORDER", `Expected event ${expected}, got ${seq}. Replay from ${expected}.`, { expectedSequence: expected, receivedSequence: seq });
    }
    let out;
    try {
      out = fn();
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      out = { status: e.status, body: { code: e.code, message: e.message, ...e.extra } };
    }
    if (trip && seq !== undefined) trip.lastSequence = seq;
    state.processed.set(pk, { status: out.status, body: out.body });
    return reply(out.status, out.body);
  };

  const saveEvidence = (tripId, kind, photo) => {
    if (!photo?.dataBase64) return null;
    mkdirSync(join(state.evidenceDir, tripId), { recursive: true });
    const name = `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}.${photo.mime === "image/png" ? "png" : "jpg"}`;
    writeFileSync(join(state.evidenceDir, tripId, name), Buffer.from(photo.dataBase64, "base64"));
    return `/evidence/${tripId}/${name}`;
  };

  // ── Identity ────────────────────────────────────────────────────────────────
  route("POST", "/api/session", () => {
    const t = tok("ses");
    state.sessions.add(t);
    return { token: t };
  });
  route("POST", "/api/auth/start", (req, body) => {
    const session = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!state.sessions.has(session)) throw new HttpError(401, "SESSION_REQUIRED", "Start a session first.");
    const allowed = REDIRECTS[body.client];
    if (!allowed) throw new HttpError(400, "UNKNOWN_CLIENT", `Unknown client ${body.client}.`);
    const redirectUri = body.redirectUri ?? allowed[0];
    if (!allowed.includes(redirectUri)) throw new HttpError(400, "REDIRECT_NOT_ALLOWED", "Redirect URI is not registered for this client.");
    const st = tok("st");
    state.pendingAuth.set(st, { client: body.client, redirectUri, session });
    return { url: `${req.base}/api/auth/stub/login?state=${st}`, state: st };
  });
  route("GET", "/api/auth/stub/login", (req) => {
    const st = req.query.get("state");
    const p = state.pendingAuth.get(st);
    if (!p) throw new HttpError(400, "STATE_UNKNOWN", "Sign-in expired. Start again from the app.");
    const users = Object.entries(STAFF)
      .map(([k, s]) => {
        const code = tok("code");
        state.codes.set(code, { user: k, state: st });
        return `<a class="u" href="${p.redirectUri}?code=${code}&state=${st}"><b>${s.name}</b><span>${k} · ${s.role}${s.agent?.problems?.length ? " · " + s.agent.problems[0] : ""}</span></a>`;
      })
      .join("");
    return { html: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BudGrub stub sign-in</title><style>body{font:16px system-ui;background:#0E0F13;color:#F2F3F5;padding:24px}a.u{display:block;padding:16px;margin:12px 0;border:1px solid #2E323D;border-radius:10px;color:#F2F3F5;text-decoration:none;background:#16181E}a.u span{display:block;color:#7D828F;font-size:13px;margin-top:4px}</style><h2>KEYCLOAK_MODE=stub</h2><p>Choose a test identity (client <b>${p.client}</b>).</p>${users}` };
  });
  route("POST", "/api/auth/callback", (req, body) => {
    const c = state.codes.get(body.code);
    if (!c || c.state !== body.state) throw new HttpError(400, "CODE_INVALID", "Sign-in code is invalid or expired.");
    state.codes.delete(body.code);
    state.pendingAuth.delete(body.state);
    const t = tok("stf");
    state.tokens.set(t, c.user);
    return { staff: STAFF[c.user], token: t };
  });
  route("GET", "/api/admin/me", (req) => staffFor(req));
  route("POST", "/api/admin/logout", (req) => {
    staffFor(req);
    state.tokens.delete((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return reply(204, null);
  });

  // ── Push devices ────────────────────────────────────────────────────────────
  route("POST", "/api/admin/driver/devices", (req, body) => {
    const s = driver(req);
    if (!["ios", "android"].includes(body.platform) || !body.token) throw new HttpError(400, "INVALID_DEVICE", "platform and token are required.");
    state.devices = state.devices.filter((d) => d.token !== body.token);
    state.devices.push({ staffId: s.id, platform: body.platform, token: body.token, at: state.now().toISOString() });
    return reply(204, null);
  });
  route("DELETE", "/api/admin/driver/devices", (req, body) => {
    driver(req);
    state.devices = state.devices.filter((d) => d.token !== body.token);
    return reply(204, null);
  });

  // ── Driver trips ────────────────────────────────────────────────────────────
  route("GET", "/api/admin/driver/trips", (req) => {
    const s = driver(req);
    const mine = state.trips.filter((t) => t.driverId === s.id);
    const current = mine.find((t) => t.status === "planned" || t.status === "departed") ?? null;
    return {
      current: current ? view(current) : null,
      recent: mine.filter((t) => t.status === "completed").slice(-5).reverse().map(view),
      checklist: CHECKLIST,
      idTypes: ID_TYPES,
      agent: agentSummary(s),
      minAge: MIN_AGE,
      metrcDegraded: state.metrcDegraded,
    };
  });

  route("POST", "/api/admin/driver/trips/:id/decline", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    if (t.status !== "planned") throw new HttpError(409, "TRIP_NOT_DECLINABLE", "Only a planned trip can be declined.");
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 3) throw new HttpError(400, "REASON_REQUIRED", "Give a reason for declining.");
    t.driverId = null;
    t.load = null;
    state.pool.push(t.id);
    state.declines.push({ staffId: s.id, tripId: t.id, reason, at: state.now().toISOString() });
    state.timeline[t.id].push({ kind: "declined", by: s.id, reason, at: state.now().toISOString() });
    return { ok: true, tripId: t.id, pool: true };
  });

  route("POST", "/api/admin/driver/trips/:id/load", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    return eventful(t.id, t, req, body, () => {
      if (t.status !== "planned") throw new HttpError(409, "TRIP_ALREADY_DEPARTED", "The load can only be attested before departure.");
      if (!t.manifestLockedAt) throw new HttpError(409, "MANIFEST_UNLOCKED", "The manifest is not locked.");
      if (body.manifestLockedAt && body.manifestLockedAt !== t.manifestLockedAt) throw new HttpError(409, "MANIFEST_CHANGED", "The manifest was re-issued. Rescan the load.");
      const a = body.attestation ?? {};
      if (!(a.sealed && a.notVisible && a.lockbox)) throw new HttpError(422, "ATTESTATION_INCOMPLETE", "Attest that the load is sealed, not visible and locked.");
      const expected = t.stops.filter((x) => x.status !== "cancelled").flatMap((x) => x.items.map((i) => i.metrcTag)).filter(Boolean);
      const matched = (body.scans ?? []).filter((x) => x.result === "matched").map((x) => x.tag);
      const unknown = matched.filter((x) => !expected.includes(x));
      const missing = expected.filter((x) => !matched.includes(x));
      const dupes = matched.filter((x, i) => matched.indexOf(x) !== i);
      if (unknown.length || missing.length || dupes.length) throw new HttpError(422, "LOAD_MISMATCH", "Scanned packages do not match the manifest. Contact the dispensary.", { unknown, missing, duplicates: dupes });
      if (t.loadPhotoRequired && !body.photo) throw new HttpError(422, "PHOTO_REQUIRED", "A photo of the sealed load is required.");
      const photoUrl = saveEvidence(t.id, "load", body.photo);
      t.load = { scannedTags: matched, attestedAt: a.attestedAt ?? state.now().toISOString(), photoUrl, deviceTs: body.deviceTs ?? null, scans: body.scans };
      state.timeline[t.id].push({ kind: "load_attested", at: t.load.attestedAt, tags: matched.length });
      return { status: 201, body: { ok: true, load: t.load } };
    });
  });

  route("POST", "/api/admin/dispatch/trips/:id/depart", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    if (t.status !== "planned") throw new HttpError(409, "TRIP_NOT_PLANNED", "Trip already departed.");
    if (state.enforceHours) {
      const h = state.now().getHours();
      if (h < 8 || h >= 22) throw new HttpError(409, "OUTSIDE_LICENSED_HOURS", "Deliveries are only allowed 8 AM–10 PM.");
    }
    if (!t.manifestLockedAt) throw new HttpError(409, "MANIFEST_UNLOCKED", "The manifest is not locked.");
    if (t.capFlowerEquivG != null && t.flowerEquivG > t.capFlowerEquivG) throw new HttpError(409, "OVER_TRIP_CAP", "Trip is over the per-trip cap.");
    if (state.metrcDegraded && !body.manualManifest) throw new HttpError(409, "METRC_DEGRADED", "Metrc is degraded; the dispatcher must record a manual manifest.");
    if (!t.load?.attestedAt) throw new HttpError(409, "LOAD_NOT_ATTESTED", "Scan every package and attest the sealed load before departing.");
    const missing = CHECKLIST.filter((c) => body.checklist?.[c.key] !== true).map((c) => c.key);
    if (missing.length) throw new HttpError(422, "CHECKLIST_INCOMPLETE", `Checklist incomplete: ${missing.join(", ")}.`);
    t.status = "departed";
    t.floatIssuedCents = Math.max(0, Number(body.floatIssuedCents) || 0);
    t.departedAt = state.now().toISOString();
    state.timeline[t.id].push({ kind: "departed", at: t.departedAt });
    return view(t);
  });

  route("POST", "/api/admin/dispatch/trips/:id/stops/:orderId/pay-link", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    const st = stopOf(t, p.orderId);
    if (st.paymentMethod !== "cash") throw new HttpError(409, "NOT_CASH", "Stop is already paid by bank.");
    st.payLink = { status: "pending", expiresAt: new Date(state.now().getTime() + 15 * 60_000).toISOString(), url: `https://pay.example.test/l/${randomUUID().slice(0, 8)}` };
    return { url: st.payLink.url, sentTo: "(702) ***-" + st.phone.slice(-4), expiresAt: st.payLink.expiresAt };
  });

  route("POST", "/api/admin/dispatch/trips/:id/stops/:orderId/:action", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    return eventful(t.id, t, req, body, () => {
      if (t.status !== "departed") throw new HttpError(409, "TRIP_NOT_DEPARTED", "Depart the trip first.");
      if (t.planAcknowledgedVersion < t.planVersion) throw new HttpError(409, "PLAN_NOT_ACKNOWLEDGED", `Acknowledge plan v${t.planVersion} first.`);
      const st = stopOf(t, p.orderId);
      const at = body.deviceTs ?? state.now().toISOString();
      if (["delivered", "returned", "cancelled"].includes(st.status)) throw new HttpError(409, "STOP_SETTLED", "This stop is already settled.");
      let idCheck = null;
      let metrc = null;
      switch (p.action) {
        case "en-route":
          if (st.status !== "pending") throw new HttpError(409, "BAD_TRANSITION", "Stop is not pending.");
          if (t.stops.some((x) => x.orderId !== st.orderId && ["en_route", "arrived"].includes(x.status))) throw new HttpError(409, "ANOTHER_STOP_ACTIVE", "Finish the current stop first.");
          if (t.stops.some((x) => x.seq < st.seq && x.status === "pending")) throw new HttpError(409, "OUT_OF_PLAN_ORDER", "Stops must be visited in plan order.");
          st.status = "en_route";
          break;
        case "arrived":
          if (st.status !== "en_route") throw new HttpError(409, "BAD_TRANSITION", "Head to the stop first.");
          st.status = "arrived";
          st.arrivedAt = at;
          break;
        case "phone": {
          const outcomes = ["confirmed", "no_answer", "voicemail", "wrong_number", "declined"];
          if (!outcomes.includes(body.outcome)) throw new HttpError(400, "BAD_OUTCOME", "Unknown call outcome.");
          st.phoneAttempts.push({ at, outcome: body.outcome, note: body.note ?? null });
          if (body.outcome === "confirmed") st.phoneConfirmedAt = at;
          break;
        }
        case "id-check": {
          if (st.status !== "arrived") throw new HttpError(409, "BAD_TRANSITION", "Arrive at the stop first.");
          idCheck = checkId(body, st.recipient, state.now());
          // Logged: pass/fail, reasons, document type, last 4, DOB year, time, agent. Never the full DOB or an image.
          st.idChecks.push({ at, ok: idCheck.ok, reasons: idCheck.reasons, idType: body.idType, last4: body.last4 ?? null, dobYear: body.dob ? Number(String(body.dob).slice(0, 4)) : null, agent: s.id, source: body.source ?? "manual" });
          if (idCheck.ok) st.idVerifiedAt = at;
          break;
        }
        case "deliver": {
          if (st.status !== "arrived") throw new HttpError(409, "BAD_TRANSITION", "Arrive at the stop first.");
          if (!st.phoneConfirmedAt) throw new HttpError(409, "PHONE_NOT_CONFIRMED", "Confirm with the customer by phone first.");
          if (!st.idVerifiedAt) throw new HttpError(409, "ID_CHECK_REQUIRED", "Hand-over refused: no passing ID check on this stop.");
          const paidAtDoor = st.payLink?.status === "paid";
          if (st.paymentMethod === "cash" && !paidAtDoor) {
            const received = Number(body.cashReceivedCents);
            if (!Number.isFinite(received) || received < st.totalCents) throw new HttpError(422, "CASH_SHORT", "Cash received is less than the order total.");
            const change = received - st.totalCents;
            const drawer = view(t).floatAvailableCents;
            if (change > drawer) throw new HttpError(422, "CHANGE_EXCEEDS_FLOAT", "Not enough float to make change.");
            st.cash = { receivedCents: received, changeCents: change };
          }
          if (paidAtDoor) st.settledMethod = "aeropay_door";
          st.status = "delivered";
          st.deliveredAt = at;
          metrc = state.metrcDegraded ? { status: "queued" } : { status: "completed", reportedAt: state.now().toISOString() };
          break;
        }
        case "return": {
          const reason = String(body.reason ?? "").trim();
          if (reason.length < 3) throw new HttpError(400, "REASON_REQUIRED", "Give a reason for the return.");
          st.status = "returned";
          st.returnReason = reason;
          st.returnedAt = at;
          metrc = { status: state.metrcDegraded ? "queued" : "returned_to_inventory" };
          break;
        }
        default:
          throw new HttpError(404, "UNKNOWN_ACTION", `Unknown stop action ${p.action}.`);
      }
      state.timeline[t.id].push({ kind: `stop_${p.action}`, orderId: st.orderId, at, ok: idCheck?.ok });
      return { status: 200, body: { stop: st, idCheck, metrc } };
    });
  });

  route("POST", "/api/admin/dispatch/trips/:id/complete", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    if (t.status !== "departed") throw new HttpError(409, "TRIP_NOT_DEPARTED", "Trip is not in progress.");
    if (t.stops.some((x) => !["delivered", "returned", "cancelled"].includes(x.status))) throw new HttpError(409, "STOPS_OPEN", "Settle every stop first.");
    t.status = "completed";
    t.completedAt = state.now().toISOString();
    t.floatReturnedCents = Number(body.floatReturnedCents) || 0;
    const expected = view(t).floatAvailableCents;
    state.timeline[t.id].push({ kind: "completed", at: t.completedAt, cashVarianceCents: t.floatReturnedCents - expected });
    return view(t);
  });

  route("POST", "/api/admin/driver/trips/:id/location", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    return eventful(t.id, t, req, body, () => {
      if (!Array.isArray(body.pings) || !body.pings.length) throw new HttpError(400, "PINGS_REQUIRED", "pings must be a non-empty array.");
      for (const g of body.pings) state.traces[t.id].push({ ...g, receivedAt: state.now().toISOString() });
      return { status: 202, body: { accepted: body.pings.length } };
    });
  });

  route("POST", "/api/admin/driver/trips/:id/ack-plan", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    if (body.version !== t.planVersion) throw new HttpError(409, "PLAN_VERSION_STALE", `Current plan is v${t.planVersion}.`);
    t.planAcknowledgedVersion = t.planVersion;
    state.timeline[t.id].push({ kind: "plan_acknowledged", version: t.planVersion, at: state.now().toISOString() });
    return { ok: true };
  });

  route("POST", "/api/admin/driver/trips/:id/events", (req, body, p) => {
    const s = driver(req);
    const t = tripOf(s, p.id);
    return eventful(t.id, t, req, body, () => {
      if (!["fuel_stop", "dwell"].includes(body.kind)) throw new HttpError(400, "UNKNOWN_EVENT", "kind must be fuel_stop or dwell.");
      if (t.status !== "departed") throw new HttpError(409, "TRIP_NOT_DEPARTED", "Trip is not in progress.");
      if (body.kind === "fuel_stop" && (!body.startedAt || !body.endedAt)) throw new HttpError(400, "TIMES_REQUIRED", "startedAt and endedAt are required.");
      const ev = { id: `tev_${randomUUID().slice(0, 8)}`, kind: body.kind, lat: body.lat ?? null, lng: body.lng ?? null, startedAt: body.startedAt ?? null, endedAt: body.endedAt ?? null, note: body.note ?? null, receiptUrl: saveEvidence(t.id, "receipt", body.photo), at: body.deviceTs ?? state.now().toISOString() };
      state.timeline[t.id].push(ev);
      return { status: 201, body: { event: ev } };
    });
  });

  route("GET", "/api/admin/dispatch/trips/:id/plans", (req, body, p) => {
    staffFor(req);
    return { plans: state.plans[p.id] ?? [] };
  });
  route("GET", "/api/admin/dispatch/trips/:id/timeline", (req, body, p) => {
    staffFor(req);
    return { timeline: state.timeline[p.id] ?? [], trace: state.traces[p.id] ?? [] };
  });

  route("POST", "/api/admin/incidents", (req, body) => {
    const s = staffFor(req);
    return eventful(`incidents:${s.id}`, null, req, body, () => {
      if (!["crash", "theft_loss", "unauthorized_stop", "other"].includes(body.kind)) throw new HttpError(400, "BAD_KIND", "Unknown incident kind.");
      if (String(body.description ?? "").trim().length < 5) throw new HttpError(400, "DESCRIPTION_REQUIRED", "Describe what happened.");
      const n = state.incidents.length + 1;
      const due = body.kind === "crash" ? 12 * 3600_000 : body.kind === "theft_loss" ? 0 : 24 * 3600_000;
      const inc = { id: `inc_${n}`, number: `INC-${String(n).padStart(4, "0")}`, ...body, reportedBy: s.id, reportedAt: state.now().toISOString(), boardDueAt: new Date(state.now().getTime() + due).toISOString(), notified: ["dispatch", "compliance"] };
      state.incidents.push(inc);
      if (body.tripId && state.timeline[body.tripId]) state.timeline[body.tripId].push({ kind: "incident", incident: inc.number, incidentKind: body.kind, at: inc.reportedAt });
      return { status: 201, body: inc };
    });
  });

  // ── Mock controls (dispatch side) ─────────────────────────────────────────
  route("POST", "/api/__mock/reset", () => {
    const evidenceDir = state.evidenceDir;
    Object.assign(state, createState(state.now), { evidenceDir });
    return { ok: true, tripId: state.trips[0].id };
  });
  route("GET", "/api/__mock/state", () => ({ trips: state.trips.map((t) => ({ ...view(t), driverId: t.driverId })), pool: state.pool, declines: state.declines, incidents: state.incidents, devices: state.devices, timeline: state.timeline, traces: Object.fromEntries(Object.entries(state.traces).map(([k, v]) => [k, v.length])) }));
  route("POST", "/api/__mock/assign", (req, body) => {
    const t = seedTrip(state.now(), body.driverId ?? "stf_jamal");
    state.trips.push(t);
    state.timeline[t.id] = [];
    state.traces[t.id] = [];
    state.plans[t.id] = [{ version: 1, at: state.now().toISOString(), stops: t.stops.map((s) => s.orderId), reason: "Initial plan" }];
    return { tripId: t.id };
  });
  route("POST", "/api/__mock/trips/:id/amend-plan", (req, body, p) => {
    const t = state.trips.find((x) => x.id === p.id);
    if (!t) throw new HttpError(404, "TRIP_NOT_FOUND", "No trip.");
    const open = t.stops.filter((x) => x.status === "pending").reverse();
    let seq = t.stops.filter((x) => x.status !== "pending").length;
    for (const st of open) st.seq = ++seq;
    t.stops.sort((a, b) => a.seq - b.seq);
    t.planVersion++;
    t.returnToStore = body.returnToStore ?? t.returnToStore;
    state.plans[t.id].push({ version: t.planVersion, at: state.now().toISOString(), stops: t.stops.map((s) => s.orderId), reason: body.reason ?? "Dispatch reordered the remaining stops" });
    return { planVersion: t.planVersion };
  });
  route("POST", "/api/__mock/trips/:id/reissue-manifest", (req, body, p) => {
    const t = state.trips.find((x) => x.id === p.id);
    if (!t) throw new HttpError(404, "TRIP_NOT_FOUND", "No trip.");
    t.manifestLockedAt = new Date(state.now().getTime() + 1000).toISOString();
    t.load = null;
    return { manifestLockedAt: t.manifestLockedAt };
  });
  route("POST", "/api/__mock/trips/:id/stops/:orderId/pay", (req, body, p) => {
    const t = state.trips.find((x) => x.id === p.id);
    const st = t && stopOf(t, p.orderId);
    if (!st?.payLink) throw new HttpError(409, "NO_LINK", "No pay link.");
    st.payLink.status = "paid";
    return { ok: true };
  });
  route("POST", "/api/__mock/metrc", (req, body) => {
    state.metrcDegraded = Boolean(body.degraded);
    return { metrcDegraded: state.metrcDegraded };
  });

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    req.query = url.searchParams;
    req.base = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, "NOT_FOUND", `No route ${req.method} ${url.pathname}`);
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, body, params);
      if (out && typeof out === "object" && "html" in out) return send(200, out.html, "text/html; charset=utf-8");
      if (out?.[REPLY]) {
        if (out.status === 204) {
          res.writeHead(204);
          return res.end();
        }
        return send(out.status, out.body);
      }
      return send(200, out);
    } catch (e) {
      if (e instanceof SyntaxError) return send(400, { code: "BAD_JSON", message: "Body is not valid JSON." });
      if (e instanceof HttpError) return send(e.status, { code: e.code, message: e.message, ...e.extra });
      console.error(e);
      return send(500, { code: "INTERNAL", message: "Internal error" });
    }
  };
}

export function createServer(state = createState()) {
  const handler = createApp(state);
  const server = createHttpServer((req, res) => void handler(req, res));
  return { server, state };
}
