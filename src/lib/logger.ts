/**
 * Structured logging.
 *
 * One JSON object per line in production (machine parseable), pretty single
 * lines in development. Never log secrets, session tokens, raw IPs or email
 * bodies — `redact()` is applied to every context object before output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authorization|apikey|api_key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function currentLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (configured in LEVELS) return LEVELS[configured];
  return process.env.NODE_ENV === "production" ? LEVELS.info : LEVELS.debug;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, base: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const record = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(redact(base) as Record<string, unknown>),
    ...(ctx ? (redact(ctx) as Record<string, unknown>) : {}),
  };
  const line = process.env.NODE_ENV === "production" ? JSON.stringify(record) : formatPretty(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function formatPretty(record: Record<string, unknown>): string {
  const { t, level, msg, ...rest } = record;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${String(t).slice(11, 23)} ${String(level).toUpperCase().padEnd(5)} ${msg}${extra}`;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, ctx) => emit("debug", bindings, msg, ctx),
    info: (msg, ctx) => emit("info", bindings, msg, ctx),
    warn: (msg, ctx) => emit("warn", bindings, msg, ctx),
    error: (msg, ctx) => emit("error", bindings, msg, ctx),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ app: "dextube" });
