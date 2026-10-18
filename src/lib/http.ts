/**
 * HTTP helpers for route handlers: consistent JSON envelopes, error mapping,
 * request ids, body validation and CSRF (same-origin) enforcement.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { AppError, isAppError, validationFailed, zodDetails } from "./errors";
import { logger } from "./logger";

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, string[]> };
  requestId: string;
}

function requestId(): string {
  return crypto.randomUUID();
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { status: 200, ...init });
}

export function jsonCreated<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

export function jsonNoContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/** Maps any thrown value to a safe HTTP response. */
export function jsonError(error: unknown): NextResponse {
  const id = requestId();
  if (isAppError(error)) {
    if (error.status >= 500) logger.error("request failed", { requestId: id, code: error.code, err: message(error) });
    return NextResponse.json<ApiError>(
      { error: { code: error.code, message: error.message, details: error.details }, requestId: id },
      { status: error.status, headers: error.headers },
    );
  }
  logger.error("unhandled error", { requestId: id, err: message(error), stack: stack(error) });
  return NextResponse.json<ApiError>(
    { error: { code: "INTERNAL", message: "Something went wrong on our side." }, requestId: id },
    { status: 500 },
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function stack(e: unknown): string | undefined {
  return e instanceof Error ? e.stack?.split("\n").slice(0, 5).join(" | ") : undefined;
}

/** Wraps a route handler so thrown errors become consistent responses. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return jsonError(error);
    }
  };
}

/** Parses and validates a JSON body, throwing a 422 with field details. */
export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed("Please check the highlighted fields.", zodDetails(parsed.error));
  return parsed.data;
}

/** Parses and validates URL search params, throwing a 422 with field details. */
export function parseQuery<T>(req: Request, schema: ZodType<T>): T {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed("Invalid query parameters.", zodDetails(parsed.error));
  return parsed.data;
}

/**
 * Client IP, used only for rate limiting and anonymous view de-duplication.
 * `X-Forwarded-For` is trusted only when `DEXTUBE_TRUST_PROXY=1` (set this
 * behind your own reverse proxy, never on a directly exposed server).
 */
export function clientIp(req: Request): string {
  if (process.env.DEXTUBE_TRUST_PROXY === "1") {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
  }
  return req.headers.get("x-real-ip")?.trim() || "127.0.0.1";
}

/**
 * CSRF defence for cookie-authenticated state changes.
 *
 * DEXTube sessions use `SameSite=Lax` cookies plus this explicit origin check:
 * a mutation must come from the same origin as the application. Requests with
 * no Origin/Referer header at all (some native clients, curl) are rejected for
 * cookie-authenticated mutations — use an `Authorization: Bearer` header for
 * programmatic access instead (see `scripts/api-example.sh`).
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");
  if (!host) throw new AppError("BAD_REQUEST", "Missing Host header.");

  const allowed = new Set<string>();
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      /* ignore malformed APP_URL, validated elsewhere */
    }
  }
  allowed.add(`http://${host}`);
  allowed.add(`https://${host}`);

  const candidate = origin ?? (referer ? safeOrigin(referer) : null);
  if (!candidate) {
    throw new AppError("FORBIDDEN", "Cross-site request blocked (missing Origin header).");
  }
  if (!allowed.has(candidate)) {
    throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
