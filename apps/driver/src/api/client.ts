import { API_BASE, AUTH_CLIENT, AUTH_REDIRECT } from "@/config";
import { NetworkError, parseError } from "./errors";
import { normalizeDriverTrips, unwrapPayLink, unwrapTrip } from "./normalize";
import type { DriverTripsResponse, StaffMe } from "./types";

/**
 * Thin fetch client for the BudGrub API, mirroring apps/admin/src/lib/api.ts. The staff token is sent as
 * `Authorization: Bearer` on every admin call; a 401 anywhere means the token was revoked or the user suspended, so
 * listeners drop the app back to sign-in.
 *
 * Calls that must reach the server immediately (sign-in, departure, decline, plan ack, pay link, trip close) go through
 * here directly. Compliance events go through the offline queue (src/sync) instead.
 *
 * Trip payloads pass through ./normalize, which maps the API's field names onto the ones the screens read.
 */
export { ApiError, NetworkError, parseError } from "./errors";

let token: string | null = null;
const unauthorizedListeners = new Set<() => void>();

export const auth = {
  setToken(t: string | null) {
    token = t;
  },
  getToken() {
    return token;
  },
  onUnauthorized(fn: () => void) {
    unauthorizedListeners.add(fn);
    return () => {
      unauthorizedListeners.delete(fn);
    };
  },
  emitUnauthorized() {
    for (const fn of unauthorizedListeners) fn();
  },
};

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Use this bearer instead of the staff token (anonymous session during sign-in). */
  bearer?: string | null;
  timeoutMs?: number;
}

export async function rawRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  const bearer = opts.bearer === undefined ? token : opts.bearer;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error && e.name === "AbortError" ? "The request timed out" : undefined);
  } finally {
    clearTimeout(timer);
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, opts);
  if (res.status === 401 && opts.bearer === undefined) {
    auth.emitUnauthorized();
    throw await parseError(res);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 that is not JSON is a captive portal or proxy page, not the API: treat it like having no connection.
    throw new NetworkError("BudGrub could not be reached on this network");
  }
}

const enc = encodeURIComponent;

export const api = {
  // Identity (apps/api/src/routes/session.ts)
  session: () => request<{ token: string }>("/session", { method: "POST", body: {}, bearer: null }),
  authStart: (sessionToken: string) =>
    request<{ url: string; state?: string }>("/auth/start", { method: "POST", body: { client: AUTH_CLIENT, redirectUri: AUTH_REDIRECT }, bearer: sessionToken }),
  authCallback: (sessionToken: string, code: string, state: string) =>
    request<{ staff: StaffMe; token: string }>("/auth/callback", { method: "POST", body: { code, state }, bearer: sessionToken }),
  me: () => request<StaffMe | { staff: StaffMe }>("/admin/me").then((r) => ("staff" in r ? r.staff : r)),
  logout: () => request<void>("/admin/logout", { method: "POST", body: {} }),

  // Push (services/notifications.ts)
  registerDevice: (platform: "ios" | "android", pushToken: string) => request<void>("/admin/driver/devices", { method: "POST", body: { platform, token: pushToken } }),
  deregisterDevice: (platform: "ios" | "android", pushToken: string) => request<void>("/admin/driver/devices", { method: "DELETE", body: { platform, token: pushToken } }),

  // Trips (routes/admin/dispatch.ts)
  driverTrips: () => request<DriverTripsResponse>("/admin/driver/trips").then(normalizeDriverTrips),
  decline: (tripId: string, reason: string) => request<{ ok: true }>(`/admin/driver/trips/${enc(tripId)}/decline`, { method: "POST", body: { reason } }),
  depart: (tripId: string, checklist: Record<string, boolean>, floatIssuedCents: number) =>
    request<unknown>(`/admin/dispatch/trips/${enc(tripId)}/depart`, { method: "POST", body: { checklist, floatIssuedCents } }).then(unwrapTrip),
  ackPlan: (tripId: string, version: number) => request<unknown>(`/admin/driver/trips/${enc(tripId)}/ack-plan`, { method: "POST", body: { version } }),
  payLink: (tripId: string, orderId: string) =>
    request<unknown>(`/admin/dispatch/trips/${enc(tripId)}/stops/${enc(orderId)}/pay-link`, { method: "POST", body: {} }).then(unwrapPayLink),
  complete: (tripId: string, floatReturnedCents: number) =>
    request<unknown>(`/admin/dispatch/trips/${enc(tripId)}/complete`, { method: "POST", body: { floatReturnedCents } }).then(unwrapTrip),
};

/** Paths for queued (idempotent, sequenced) events. */
export const eventPaths = {
  stopAction: (tripId: string, orderId: string, action: string) => `/admin/dispatch/trips/${enc(tripId)}/stops/${enc(orderId)}/${action}`,
  location: (tripId: string) => `/admin/driver/trips/${enc(tripId)}/location`,
  load: (tripId: string) => `/admin/driver/trips/${enc(tripId)}/load`,
  events: (tripId: string) => `/admin/driver/trips/${enc(tripId)}/events`,
  incidents: () => "/admin/incidents",
};
