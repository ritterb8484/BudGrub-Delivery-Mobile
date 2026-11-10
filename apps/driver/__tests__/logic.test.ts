import type { StaffMe, Trip, TripStop } from "@/api/types";
import { eligibility } from "@/auth/eligibility";
import { money } from "@/lib/format";
import { manifestLines, newSession, scanTag, sessionIsStale, summarise } from "@/load/manifest";
import { navigationUrls } from "@/nav/deeplink";
import { applyPending } from "@/sync/overlay";
import type { QueuedEvent } from "@/sync/queue";

const stop = (o: Partial<TripStop>): TripStop => ({
  orderId: "o1", orderNumber: "BG-1001", seq: 1, status: "pending", recipient: "Jamal Pierce", address: { line1: "1 Main", city: "Las Vegas", zip: "89101" },
  items: [], totalCents: 5400, paymentMethod: "cash", windowLabel: "2–4 PM", phoneConfirmedAt: null, phoneAttempts: [], idVerifiedAt: null, idChecks: [], ...o,
});
const trip = (stops: TripStop[]): Trip => ({
  id: "t1", number: "TR-1", status: "planned", vehicle: { label: "Van 2" }, flowerEquivG: 28, cashExpectedCents: 5400, floatIssuedCents: 2000, floatAvailableCents: 2000,
  manifestLockedAt: "2026-11-10T16:00:00Z", planVersion: 1, planAcknowledgedVersion: 1, stops,
});

describe("load scan against the manifest", () => {
  const t = trip([
    stop({ items: [{ name: "Blue Dream 3.5g", qty: 1, metrcTag: "1A4060300003B01000012345" }, { name: "Gummies", qty: 2, metrcTag: "1A4060300003B01000012346" }] }),
    stop({ orderId: "o2", orderNumber: "BG-1002", seq: 2, items: [{ name: "Vape", qty: 1, metrcTag: "1A4060300003B01000012347" }] }),
    stop({ orderId: "o3", orderNumber: "BG-1003", seq: 3, status: "cancelled", items: [{ name: "Gone", qty: 1, metrcTag: "1A4060300003B01000099999" }] }),
  ]);
  const lines = manifestLines(t);

  it("requires every manifest line once and excludes cancelled stops", () => {
    expect(lines.map((l) => l.tag.slice(-5))).toEqual(["12345", "12346", "12347"]);
    let s = newSession(t);
    for (const tag of ["1a40603 00003B01000012345", "1A4060300003B01000012346"]) s = scanTag(s, lines, tag, "now").session;
    let sum = summarise(s, lines);
    expect(sum.complete).toBe(false);
    expect(sum.missing.map((m) => m.orderNumber)).toEqual(["BG-1002"]);
    s = scanTag(s, lines, "1A4060300003B01000012347", "now").session;
    sum = summarise(s, lines);
    expect(sum).toMatchObject({ complete: true, blockedReason: null });
  });

  it("flags duplicates and unknown tags; an unknown tag blocks departure", () => {
    let s = newSession(t);
    s = scanTag(s, lines, "1A4060300003B01000012345", "now").session;
    const dup = scanTag(s, lines, "1A4060300003B01000012345", "now");
    expect(dup.outcome.kind).toBe("duplicate");
    const unk = scanTag(dup.session, lines, "1A4060300003B01000099999", "now");
    expect(unk.outcome.kind).toBe("unknown");
    let all = unk.session;
    for (const tag of ["1A4060300003B01000012346", "1A4060300003B01000012347"]) all = scanTag(all, lines, tag, "now").session;
    const sum = summarise(all, lines);
    expect(sum.complete).toBe(false);
    expect(sum.unknownTags).toEqual(["1A4060300003B01000099999"]);
    expect(sum.duplicates).toHaveLength(1);
  });

  it("treats a re-issued manifest as a new scan session", () => {
    const s = newSession(t);
    expect(sessionIsStale(s, t)).toBe(false);
    expect(sessionIsStale(s, { ...t, manifestLockedAt: "2026-11-10T16:30:00Z" })).toBe(true);
    expect(sessionIsStale(null, t)).toBe(true);
  });
});

describe("offline overlay", () => {
  const ev = (seq: number, meta: Record<string, unknown>, status: QueuedEvent["status"] = "pending"): QueuedEvent => ({
    id: `e${seq}`, scope: "trip:t1", sequence: seq, sequenced: true, kind: "stop_action", path: "/", body: {}, deviceTs: `2026-11-10T17:0${seq}:00Z`,
    status, attempts: 0, lastError: null, response: null, ackedAt: null, meta,
  });

  it("applies queued stop actions in order and updates the cash drawer", () => {
    const t = trip([stop({ status: "pending" })]);
    const out = applyPending(t, [
      ev(1, { orderId: "o1", action: "en-route" }),
      ev(2, { orderId: "o1", action: "arrived" }),
      ev(3, { orderId: "o1", action: "phone", outcome: "confirmed" }),
      ev(4, { orderId: "o1", action: "id-check", localOk: true }),
      ev(5, { orderId: "o1", action: "deliver", cashReceivedCents: 6000, changeCents: 600 }),
    ]);
    expect(out.stops[0]).toMatchObject({ status: "delivered", phoneConfirmedAt: "2026-11-10T17:03:00Z", idVerifiedAt: "2026-11-10T17:04:00Z" });
    expect(out.floatAvailableCents).toBe(2000 + 5400);
    expect(t.stops[0].status).toBe("pending"); // input untouched
  });

  it("ignores acknowledged events (server state wins)", () => {
    const t = trip([stop({ status: "arrived" })]);
    expect(applyPending(t, [ev(1, { orderId: "o1", action: "en-route" }, "acked")]).stops[0].status).toBe("arrived");
  });
});

describe("eligibility (cannabis mode gating)", () => {
  const me = (o: Partial<StaffMe> = {}): StaffMe => ({
    id: "s1", name: "Jamal Pierce", role: "driver", status: "active",
    agent: { agentCardNumber: "NV-AG-1234", agentCardExpires: "2027-06-30", disclosedToCcb: true, status: "active", problems: [] }, ...o,
  });
  const today = new Date("2026-11-10T12:00:00Z");

  it("allows cannabis mode for an active, disclosed, unexpired agent", () => {
    expect(eligibility(me(), today)).toEqual({ cannabis: true, courier: true, problems: [] });
  });
  it("falls back to courier when the agent card is expired, missing or undisclosed", () => {
    expect(eligibility(me({ agent: { agentCardNumber: "X", agentCardExpires: "2026-11-09", disclosedToCcb: true } }), today)).toMatchObject({ cannabis: false, courier: true });
    expect(eligibility(me({ agent: null }), today).cannabis).toBe(false);
    expect(eligibility(me({ agent: { agentCardNumber: "X", agentCardExpires: "2027-01-01", disclosedToCcb: false } }), today).problems).toContain("Agent card not disclosed to the CCB");
  });
  it("blocks both modes for suspended or non-driver staff", () => {
    expect(eligibility(me({ status: "suspended" }), today)).toMatchObject({ cannabis: false, courier: false });
    expect(eligibility(me({ role: "dispatcher" }), today)).toMatchObject({ cannabis: false, courier: false });
  });
});

describe("navigation deep links", () => {
  it("targets a single destination with no waypoints", () => {
    const ios = navigationUrls({ lat: 36.1, lng: -115.1, label: "BG-1001" }, "ios");
    const android = navigationUrls({ lat: 36.1, lng: -115.1, label: "BG-1001" }, "android");
    expect(ios[0]).toBe("maps://?daddr=36.1,-115.1&q=BG-1001&dirflg=d");
    expect(android[0]).toBe("google.navigation:q=36.1,-115.1&mode=d");
    for (const u of [...ios, ...android]) expect(u).not.toMatch(/waypoint/);
  });
});

describe("money", () => {
  it("formats cents like the web console", () => {
    expect(money(5400)).toBe("$54.00");
    expect(money(123456)).toBe("$1,234.56");
    expect(money(-50)).toBe("-$0.50");
  });
});
