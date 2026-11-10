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

export async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const b = (body ?? {}) as { code?: string; error?: string | { code?: string; message?: string }; message?: string };
  const nested = typeof b.error === "object" && b.error ? b.error : null;
  const code = b.code ?? nested?.code ?? (typeof b.error === "string" ? b.error : `HTTP_${res.status}`);
  const message = b.message ?? nested?.message ?? (typeof b.error === "string" ? b.error : res.statusText || `Request failed (${res.status})`);
  return new ApiError(res.status, code, message, body);
}
