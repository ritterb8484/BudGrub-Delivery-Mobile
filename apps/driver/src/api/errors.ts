/** Error types shared by the API client and the sync sender. No platform imports, so they are testable in Node. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: unknown = null) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(message = "No connection to BudGrub") {
    super(message);
    this.name = "NetworkError";
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/**
 * Extra fields of an error body (for example `expectedSequence` on OUT_OF_ORDER), wherever the server put them:
 * at the top level, or under `details` as apps/api does.
 */
export function errorDetails(body: unknown): Obj {
  const b = obj(body);
  return { ...(b ?? {}), ...(obj(b?.details) ?? {}) };
}

/**
 * Error bodies come in three shapes:
 *   apps/api       { error: "message", details: { code, ... } | null }
 *   apps/mock-api  { code, message, ... }
 *   and            { error: { code, message } }
 * A body with no code gets `HTTP_<status>`, never the message, so callers can compare codes safely.
 */
export async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const b = obj(body) ?? {};
  const nested = obj(b.error);
  const details = obj(b.details);
  const code = text(b.code) ?? text(nested?.code) ?? text(details?.code) ?? `HTTP_${res.status}`;
  const message = text(b.message) ?? text(nested?.message) ?? text(b.error) ?? (res.statusText || `Request failed (${res.status})`);
  return new ApiError(res.status, code, message, body);
}
