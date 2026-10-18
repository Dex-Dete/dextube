/**
 * Typed application errors.
 *
 * Services throw `AppError`; a single mapper in `src/lib/http.ts` turns them
 * into safe HTTP responses. Internal details are never leaked to clients for
 * 5xx responses.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "PRECONDITION_FAILED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  PRECONDITION_FAILED: 412,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Field-level details for validation errors (safe to show the user). */
  readonly details?: Record<string, string[]>;
  /** Extra headers (e.g. Retry-After for rate limits). */
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, string[]>; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export const badRequest = (m = "Bad request", details?: Record<string, string[]>) =>
  new AppError("BAD_REQUEST", m, { details });
export const validationFailed = (m = "Validation failed", details?: Record<string, string[]>) =>
  new AppError("VALIDATION_FAILED", m, { details });
export const unauthenticated = (m = "You must be signed in to do that.") =>
  new AppError("UNAUTHENTICATED", m);
export const forbidden = (m = "You do not have permission to do that.") =>
  new AppError("FORBIDDEN", m);
export const notFound = (m = "Not found") => new AppError("NOT_FOUND", m);
export const conflict = (m = "That already exists.") => new AppError("CONFLICT", m);
export const payloadTooLarge = (m = "That file is too large.") =>
  new AppError("PAYLOAD_TOO_LARGE", m);
export const unsupportedMedia = (m = "Unsupported media type.") =>
  new AppError("UNSUPPORTED_MEDIA_TYPE", m);
export const rateLimited = (retryAfterSeconds: number, m = "Too many requests. Please slow down.") =>
  new AppError("RATE_LIMITED", m, {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
export const preconditionFailed = (m = "Precondition failed.") =>
  new AppError("PRECONDITION_FAILED", m);
export const internal = (m = "Something went wrong on our side.", cause?: unknown) =>
  new AppError("INTERNAL", m, { cause });

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Flattens a ZodError into `{ field: [messages] }` for the API response.
 * Accepts `unknown` so it does not import zod at runtime for non-zod errors.
 */
export function zodDetails(error: {
  issues: Array<{ path: Array<string | number | symbol>; message: string }>;
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
