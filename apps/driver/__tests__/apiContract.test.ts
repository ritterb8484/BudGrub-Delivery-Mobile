import { errorDetails, parseError } from "@/api/errors";
import { normalizeDriverTrips, normalizeStop, unwrapPayLink, unwrapTrip } from "@/api/normalize";
import type { DriverTripsResponse } from "@/api/types";
import type { QueuedEvent } from "@/sync/queue";
import { createHttpSender } from "@/sync/sender";

/** Responses in the shape apps/api sends them (the mock API uses flatter ones; both must work). */
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("error bodies", () => {
  it("reads the code from `details` as apps/api sends it", async () => {
    const e = await parseError(json(409, { error: "Expected event 4, received 9. Send from 4.", details: { code: "OUT_OF_ORDER", expectedSequence: 4, receivedSequence: 9 } }));
    expect(e.status).toBe(409);
    expect(e.code).toBe("OUT_OF_ORDER");
    expect(e.message).toBe("Expected event 4, received 9. Send from 4.");
    expect(errorDetails(e.body).expectedSequence).toBe(4);
  });

  it("reads the mock API's flat shape and the nested-error shape", async () => {
    const flat = await parseError(json(422, { code: "LOAD_MISMATCH", message: "Scanned packages do not match.", missing: ["A"] }));
    expect([flat.code, flat.message, errorDetails(flat.body).missing]).toEqual(["LOAD_MISMATCH", "Scanned packages do not match.", ["A"]]);
    const nested = await parseError(json(400, { error: { code: "BAD", message: "Nope" } }));
    expect([nested.code, nested.message]).toEqual(["BAD", "Nope"]);
  });

  it("never uses the message as the code", async () => {
    const e = await parseError(json(404, { error: "Trip not found", details: null }));
    expect(e.code).toBe("HTTP_404");
    expect(e.message).toBe("Trip not found");
    const html = await parseError(new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect([html.code, html.message]).toEqual(["HTTP_502", "Bad Gateway"]);
  });
});

describe("queued events against the API's responses", () => {
  const event = { id: "11111111-1111-4111-8111-111111111111", path: "/admin/driver/trips/t1/location", body: { pings: [] }, deviceTs: "2026-11-10T20:00:00.000Z", sequenced: true, sequence: 9 } as unknown as QueuedEvent;
  const send = (res: Response) => createHttpSender(async () => res, { hasToken: () => true })(event);

  it("resolves OUT_OF_ORDER from the expected sequence under `details`", async () => {
    expect(await send(json(409, { error: "Expected event 4, received 9.", details: { code: "OUT_OF_ORDER", expectedSequence: 4, receivedSequence: 9 } }))).toEqual({ kind: "out_of_order", expected: 4 });
  });

  it("treats another 409 as a rejection with the server's code and message", async () => {
    expect(await send(json(409, { error: "Trip TRP-1 is completed.", details: { code: "TRIP_NOT_DEPARTED" } }))).toMatchObject({ kind: "rejected", status: 409, code: "TRIP_NOT_DEPARTED", message: "Trip TRP-1 is completed." });
  });

  it("keeps the event for a retry on a 5xx", async () => {
    expect(await send(json(500, { error: "Internal error", requestId: "r1" }))).toMatchObject({ kind: "retry" });
  });

  it("sends the idempotency key, the sequence and the device time", async () => {
    let seen: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    const sender = createHttpSender(async (_p, body, headers) => { seen = { body: body as Record<string, unknown>, headers }; return json(200, { accepted: 0 }); }, { hasToken: () => true });
    expect(await sender(event)).toMatchObject({ kind: "ok", status: 200 });
    expect(seen!.headers["Idempotency-Key"]).toBe(event.id);
    expect(seen!.body).toMatchObject({ sequence: 9, deviceTs: "2026-11-10T20:00:00.000Z" });
  });
});

describe("trip payloads", () => {
  // A stop as GET /api/admin/driver/trips returns it.
  const apiStop = {
    seq: 1, orderId: "o1", orderNumber: "BG-1001", status: "en_route", orderStatus: "out_for_delivery", recipient: "Sam Okafor",
    address: { line1: "12 Desert Way", city: "Las Vegas", state: "NV", zip: "89109" }, windowLabel: "ASAP", dropOffNote: "Gate code 4411", phone: "+1 702 555 0199",
    paymentMethod: "cash", paymentStatus: "pending", settledMethod: null, totalCents: 5920, phoneConfirmedAt: null, phoneAttempts: [], idVerifiedAt: null, idChecks: [],
    etaAt: "2026-11-10T21:15:00.000Z", routeMinutes: 14, lat: 36.1201, lng: -115.1702,
    payLink: { token: "tok", status: "pending", expiresAt: "2026-11-10T21:30:00.000Z", url: "https://budgrub.example/pay/tok" },
    items: [{ name: "Sunset Citrus 3.5g", qty: 1, metrcTag: "1A4060300003F7A000001000" }],
  };

  it("moves coordinates, ETA and the drop-off note to where the screens read them", () => {
    const s = normalizeStop(apiStop);
    expect(s.address).toMatchObject({ line1: "12 Desert Way", city: "Las Vegas", zip: "89109", lat: 36.1201, lng: -115.1702, instructions: "Gate code 4411" });
    expect(s.eta).toBe("2026-11-10T21:15:00.000Z");
    expect(s.phone).toBe("+1 702 555 0199");
    expect(s.payLink?.url).toBe("https://budgrub.example/pay/tok");
  });

  it("leaves a stop already in the app's shape alone, and survives missing lists", () => {
    const s = normalizeStop({ ...apiStop, lat: undefined, lng: undefined, etaAt: undefined, eta: "2026-11-10T22:00:00.000Z", address: { line1: "1 Main", city: "Reno", zip: "89501", lat: 39.5, lng: -119.8, instructions: "Side door" }, items: undefined, idChecks: undefined, phoneAttempts: undefined, recipient: null });
    expect(s.address).toMatchObject({ lat: 39.5, lng: -119.8, instructions: "Side door" });
    expect(s.eta).toBe("2026-11-10T22:00:00.000Z");
    expect([s.items, s.idChecks, s.phoneAttempts, s.recipient]).toEqual([[], [], [], "Customer"]);
    expect(normalizeStop({ ...apiStop, lat: null, lng: null, etaAt: null }).address).toMatchObject({ lat: null, lng: null });
  });

  it("normalises the current and recent trips of the driver payload", () => {
    const trip = { id: "t1", number: "TRP-1001", status: "departed", stops: [apiStop] };
    const out = normalizeDriverTrips({ current: trip, recent: [trip], checklist: [], idTypes: [], agent: { name: "J", agentCardNumber: null, agentCardExpires: null, problems: [] }, minAge: 21, metrcDegraded: false } as unknown as DriverTripsResponse);
    expect(out.current?.stops[0].address.lat).toBe(36.1201);
    expect(out.recent[0].stops[0].eta).toBe("2026-11-10T21:15:00.000Z");
    expect(normalizeDriverTrips({ current: null, recent: [] } as unknown as DriverTripsResponse).current).toBeNull();
  });

  it("unwraps { trip } and { link } answers, and the mock's bare ones", () => {
    const trip = { id: "t1", number: "TRP-1001", status: "departed", stops: [apiStop] };
    expect(unwrapTrip({ trip }).stops[0].address.lng).toBe(-115.1702);
    expect(unwrapTrip(trip).id).toBe("t1");
    const link = { token: "tok", url: "https://budgrub.example/pay/tok", expiresAt: "2026-11-10T21:30:00.000Z", status: "pending", sentTo: "+1 702 555 0199" };
    expect(unwrapPayLink({ link })).toEqual({ url: link.url, sentTo: link.sentTo, expiresAt: link.expiresAt });
    expect(unwrapPayLink({ url: link.url, sentTo: null, expiresAt: link.expiresAt })).toEqual({ url: link.url, sentTo: null, expiresAt: link.expiresAt });
    expect(() => unwrapPayLink({ link: { token: "tok" } })).toThrow(/payment link/);
  });
});
