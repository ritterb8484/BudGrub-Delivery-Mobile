import { errorDetails, NetworkError, parseError } from "@/api/errors";
import type { Sender } from "./queue";

/**
 * HTTP sender for queued events (BUD-124), free of platform imports so it is exercised against the mock API in tests.
 * Every event is POSTed with `Idempotency-Key: <event id>`, the device timestamp and, on sequenced scopes, `sequence`.
 *   2xx → ok · 401 → unauthorized · 409 OUT_OF_ORDER → out_of_order(expectedSequence)
 *   408/429/5xx/network → retry (event stays pending) · other 4xx → rejected (server consumed the sequence)
 */
export type Poster = (path: string, body: unknown, headers: Record<string, string>) => Promise<Response>;

export function createHttpSender(post: Poster, opts: { hasToken: () => boolean; onUnauthorized?: () => void }): Sender {
  return async (e) => {
    if (!opts.hasToken()) return { kind: "unauthorized" };
    const body = { ...e.body, deviceTs: e.deviceTs, ...(e.sequenced ? { sequence: e.sequence } : {}) };
    let res: Response;
    try {
      res = await post(e.path, body, { "Idempotency-Key": e.id });
    } catch (err) {
      return { kind: "retry", error: err instanceof NetworkError || err instanceof Error ? err.message : "Network error" };
    }
    if (res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { kind: "ok", status: res.status, body: parsed };
    }
    if (res.status === 401) {
      opts.onUnauthorized?.();
      return { kind: "unauthorized" };
    }
    const err = await parseError(res);
    if (res.status === 409 && err.code === "OUT_OF_ORDER") {
      const expected = errorDetails(err.body).expectedSequence;
      if (typeof expected === "number") return { kind: "out_of_order", expected };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", error: `${err.code}: ${err.message}` };
    return { kind: "rejected", status: res.status, code: err.code, message: err.message, body: err.body };
  };
}
