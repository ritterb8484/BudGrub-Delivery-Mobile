import type { DriverTripsResponse, Trip, TripStop } from "./types";

/**
 * The API (apps/api) and the app name a few trip fields differently. Responses are normalised here, once, so the rest
 * of the app reads one shape whichever server it talks to (the API or apps/mock-api):
 *   - stop coordinates arrive as `stops[].lat/lng`; the app reads `address.lat/lng`;
 *   - the routed ETA arrives as `etaAt`; the app reads `eta`;
 *   - delivery instructions arrive as `dropOffNote`; the app reads `address.instructions`;
 *   - mutations answer `{ trip }`, the door pay link `{ link }`.
 * No platform imports, so this is tested in Node.
 */

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export function normalizeStop(raw: TripStop | Raw): TripStop {
  const s = raw as Raw;
  const a = isObj(s.address) ? s.address : {};
  const address = {
    ...a,
    line1: str(a.line1) ?? "",
    city: str(a.city) ?? "",
    zip: str(a.zip) ?? "",
    lat: num(a.lat) ?? num(s.lat),
    lng: num(a.lng) ?? num(s.lng),
    instructions: str(a.instructions) ?? str(s.dropOffNote),
  };
  return {
    ...(s as unknown as TripStop),
    address,
    eta: str(s.eta) ?? str(s.etaAt),
    recipient: str(s.recipient) ?? "Customer",
    items: Array.isArray(s.items) ? (s.items as TripStop["items"]) : [],
    phoneAttempts: Array.isArray(s.phoneAttempts) ? (s.phoneAttempts as TripStop["phoneAttempts"]) : [],
    idChecks: Array.isArray(s.idChecks) ? (s.idChecks as TripStop["idChecks"]) : [],
  };
}

export function normalizeTrip(raw: Trip | Raw): Trip {
  const t = raw as Raw;
  return { ...(t as unknown as Trip), stops: Array.isArray(t.stops) ? (t.stops as Raw[]).map(normalizeStop) : [] };
}

/** `{ trip }` from the API, the bare trip from the mock. */
export function unwrapTrip(raw: unknown): Trip {
  const r = raw as Raw;
  return normalizeTrip(isObj(r.trip) ? r.trip : r);
}

export function normalizeDriverTrips(raw: DriverTripsResponse): DriverTripsResponse {
  return { ...raw, current: raw.current ? normalizeTrip(raw.current) : null, recent: (raw.recent ?? []).map(normalizeTrip) };
}

export interface IssuedPayLink {
  url: string;
  sentTo: string | null;
  expiresAt: string;
}

/** `{ link: { url, sentTo, expiresAt } }` from the API, the bare link from the mock. */
export function unwrapPayLink(raw: unknown): IssuedPayLink {
  const r = raw as Raw;
  const l = isObj(r.link) ? r.link : r;
  const url = str(l.url);
  if (!url) throw new Error("The server did not return a payment link. Try again, or take cash.");
  return { url, sentTo: str(l.sentTo), expiresAt: str(l.expiresAt) ?? "" };
}
