/**
 * Central configuration. Every environment-dependent value in DEXTube is read
 * through this module so that:
 *   * defaults are documented in one place,
 *   * invalid configuration fails fast at startup instead of at request time,
 *   * tests can assert on config without touching process.env directly.
 *
 * Server-only.
 */
import "server-only";
import { z } from "zod";
import { sessionCookiePolicy } from "@/lib/session-cookie";
import { parseRankingWeights, RANKING_VERSION } from "@/server/recsys/ranking";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .refine((v) => Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max, {
      message: `must be an integer between ${min} and ${max}`,
    });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().default("http://localhost:3000"),
  BIND_HOST: z.string().default("127.0.0.1"),
  PORT: int(3000, 1, 65535),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  SESSION_SECRET: z
    .string()
    .min(16, "SESSION_SECRET must be at least 16 characters (use: openssl rand -base64 48)"),
  SESSION_TTL_DAYS: int(30, 1, 365),
  /**
   * "auto" (default) makes the Secure flag and the `__Host-` prefix depend on
   * APP_URL being https. Set "true"/"false" to force it.
   */
  SESSION_COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  MEDIA_ROOT: z.string().default("./storage/media"),
  MEDIA_PUBLIC_BASE: z.string().default("/media"),

  MAX_UPLOAD_BYTES: int(2 * 1024 * 1024 * 1024, 1024, 64 * 1024 * 1024 * 1024),
  MAX_VIDEO_DURATION_SECONDS: int(7200, 1, 86400),
  PROCESSING_CONCURRENCY: int(1, 1, 8),
  /** "" | "off" disables additional renditions beyond the source. */
  TRANSCODE_LADDER: z.string().default("480,360"),
  ENABLE_HLS: bool(false),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("DEXTube <no-reply@example.invalid>"),
  SMTP_SECURE: bool(false),

  RATE_LIMIT_DISABLED: bool(false),
  LOGIN_MAX_ATTEMPTS: int(10, 1, 1000),
  LOGIN_WINDOW_MINUTES: int(15, 1, 1440),
  VIEW_DEDUPE_SECONDS: int(1800, 0, 86400),

  JOB_RUNNER: z.enum(["inline", "external"]).default("inline"),
  WORKER_POLL_MS: int(2000, 250, 60000),
  JOB_MAX_ATTEMPTS: int(3, 1, 10),

  /**
   * Optional JSON override for the recommender's weights, e.g.
   * `{"recency":1.2,"engagement":0.5}`. Unknown or non-numeric keys are
   * ignored and reported at startup rather than taking the feed down.
   */
  RANKING_WEIGHTS: z.string().optional(),

  /**
   * Which kind of deployment this process is. Deliberately separate from
   * `NODE_ENV`: `next start` forces NODE_ENV=production even for a throwaway
   * instance, so destructive helpers and the administrator bootstrap key off
   * this value instead. "isolated-test" is the only value that unlocks them.
   */
  DEXTUBE_ENV: z.enum(["development", "isolated-test", "production"]).default("development"),

  /** One-time initial administrator (see `src/server/services/admin-bootstrap.ts`). */
  ADMIN_BOOTSTRAP_ENABLED: bool(false),
  ADMIN_BOOTSTRAP_USERNAME: z.string().min(1).default("admin"),
  ADMIN_BOOTSTRAP_EMAIL: z.string().min(3).default("admin@admin.com"),
  /**
   * Whether the created administrator must change its bootstrap password before
   * it can use administrator tools.
   *
   * Default `true` (the safe default). The development instance sets it to
   * `false` so the operator account can actually be used straight away; an
   * account created that way still carries `mustChangePassword`, which the
   * administrator area shows as a warning instead of a locked door.
   */
  ADMIN_BOOTSTRAP_REQUIRE_PASSWORD_CHANGE: bool(true),
  /** Never logged. Required once bootstrap is enabled anywhere but isolated test. */
  ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),

  /**
   * What the isolated test environment is *expected* to point at. `scripts/isolated-reset.ts`
   * refuses to delete anything until the live DATABASE_URL and MEDIA_ROOT match
   * these values, so a mis-set .env can never reach the development data.
   */
  ISOLATED_DATABASE_NAME: z.string().default("dextube_isolated_test"),
  ISOLATED_MEDIA_ROOT: z.string().default("./storage/isolated-test/media"),

  /**
   * Authorized channel/playlist migration. `YOUTUBE_API_KEY` enables the
   * official Data API v3; without it only the public channel feed (metadata,
   * never media) is available.
   */
  YOUTUBE_API_KEY: z.string().optional(),
  CREATOR_EXPORT_ROOT: z.string().default("./storage/creator-exports"),
  IMPORT_MAX_ITEMS: int(500, 1, 10_000),
  IMPORT_MAX_CONCURRENCY: int(4, 1, 8),
  IMPORT_HTTP_TIMEOUT_MS: int(15_000, 1_000, 60_000),
  /**
   * Ceiling on a single response body, enforced while it is being read.
   *
   * It has to be generous enough for the largest document DEXTube legitimately
   * reads: a channel's `/@handle` page is around 1.5 MB, and the canonical link
   * that identifies the channel sits near the *end* of it, so a partial read is
   * not an option. It stays a hard, bounded ceiling rather than "read it all".
   */
  IMPORT_MAX_RESPONSE_BYTES: int(4 * 1024 * 1024, 1_024, 16 * 1024 * 1024),

  /** Refuse media imports once the storage tree exceeds this. */
  STORAGE_QUOTA_BYTES: int(50 * 1024 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024 * 1024),
});

export type AppConfig = ReturnType<typeof loadConfig>;

function loadConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `DEXTube configuration is invalid:\n${details}\n\n` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }
  const env = parsed.data;

  const isProd = env.NODE_ENV === "production";
  const isIsolatedTest = env.DEXTUBE_ENV === "isolated-test";
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const cookiePolicy = sessionCookiePolicy(appUrl, env.SESSION_COOKIE_SECURE);
  const transcodeLadder = env.TRANSCODE_LADDER.trim()
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 144 && n <= 4320)
    .sort((a, b) => b - a);

  const ranking = parseRankingWeights(env.RANKING_WEIGHTS);
  if (ranking.ignored.length > 0) {
    console.warn(
      `[dextube] RANKING_WEIGHTS ignored ${ranking.ignored.length} entr${
        ranking.ignored.length === 1 ? "y" : "ies"
      }: ${ranking.ignored.join(", ")}. Known weights: ${Object.keys(ranking.weights).join(", ")}`,
    );
  }

  if (isProd && env.SESSION_SECRET.includes("CHANGE_ME")) {
    throw new Error("Refusing to start in production with a placeholder SESSION_SECRET.");
  }
  if (isProd && env.DATABASE_URL.includes("CHANGE_ME")) {
    throw new Error("Refusing to start in production with a placeholder DATABASE_URL.");
  }
  if (isProd && !cookiePolicy.secure && process.env.NEXT_PHASE !== "phase-production-build") {
    console.warn(
      "[dextube] Session cookies are NOT Secure because APP_URL is not https://. " +
        "That is fine for a trusted local network, but never expose this instance to the " +
        "internet without TLS. Set APP_URL=https://… (or SESSION_COOKIE_SECURE=true) once " +
        "a reverse proxy terminates TLS.",
    );
  }

  // --- Administrator bootstrap safety ---------------------------------------
  // Three independent refusals, because getting this wrong hands out an admin
  // account: it is never allowed in production, it needs an explicit password
  // off isolated test, and the famously-weak "admin" password is only tolerated
  // in throwaway environments.
  if (env.ADMIN_BOOTSTRAP_ENABLED && env.DEXTUBE_ENV === "production") {
    throw new Error(
      "ADMIN_BOOTSTRAP_ENABLED must never be true when DEXTUBE_ENV=production. " +
        "Create the first administrator through the setup flow instead.",
    );
  }
  if (env.ADMIN_BOOTSTRAP_ENABLED && !isIsolatedTest && !env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error(
      "ADMIN_BOOTSTRAP_ENABLED requires ADMIN_BOOTSTRAP_PASSWORD unless DEXTUBE_ENV=isolated-test " +
        "(where the documented throwaway password may be used).",
    );
  }
  if (env.ADMIN_BOOTSTRAP_PASSWORD === "admin" && !isIsolatedTest) {
    console.warn(
      "[dextube] Bootstrapping with the well-known password \"admin\". This is only acceptable " +
        "on a throwaway local instance: the account is marked must-change-password and the " +
        "credential must never be published.",
    );
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProd,
    isTest: env.NODE_ENV === "test",
    /** "development" | "isolated-test" | "production" — see the schema comment. */
    environment: env.DEXTUBE_ENV,
    /** True only for the throwaway environment that destructive helpers may touch. */
    isIsolatedTest,
    appUrl,
    bindHost: env.BIND_HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    session: {
      secret: env.SESSION_SECRET,
      ttlDays: env.SESSION_TTL_DAYS,
      cookieName: cookiePolicy.name,
      cookieSecure: cookiePolicy.secure,
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      mediaRoot: env.MEDIA_ROOT,
      publicBase: env.MEDIA_PUBLIC_BASE.startsWith("/")
        ? env.MEDIA_PUBLIC_BASE
        : `/${env.MEDIA_PUBLIC_BASE}`,
      s3: {
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      },
    },
    uploads: {
      maxBytes: env.MAX_UPLOAD_BYTES,
      maxDurationSeconds: env.MAX_VIDEO_DURATION_SECONDS,
    },
    media: {
      processingConcurrency: env.PROCESSING_CONCURRENCY,
      transcodeLadder,
      enableHls: env.ENABLE_HLS,
    },
    /**
     * Recommender configuration. The weights are documented in
     * `src/server/recsys/ranking.ts`; `version` identifies the formula so a
     * feed ordering can be reproduced after the defaults change.
     */
    recsys: {
      weights: ranking.weights,
      weightsIgnored: ranking.ignored,
      version: RANKING_VERSION,
    },
    email: {
      host: env.SMTP_HOST || null,
      port: env.SMTP_PORT,
      user: env.SMTP_USER || null,
      password: env.SMTP_PASSWORD || null,
      from: env.SMTP_FROM,
      secure: env.SMTP_SECURE,
      get configured() {
        return Boolean(env.SMTP_HOST);
      },
    },
    rateLimit: {
      disabled: env.RATE_LIMIT_DISABLED,
      loginMaxAttempts: env.LOGIN_MAX_ATTEMPTS,
      loginWindowMs: env.LOGIN_WINDOW_MINUTES * 60_000,
      viewDedupeSeconds: env.VIEW_DEDUPE_SECONDS,
    },
    jobs: {
      runner: env.JOB_RUNNER,
      pollMs: env.WORKER_POLL_MS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
    },
    adminBootstrap: {
      /** Env switch; the database switch is checked at run time as well. */
      enabled: env.ADMIN_BOOTSTRAP_ENABLED,
      username: env.ADMIN_BOOTSTRAP_USERNAME,
      email: env.ADMIN_BOOTSTRAP_EMAIL,
      /** Never logged, never returned by an API. */
      password: env.ADMIN_BOOTSTRAP_PASSWORD ?? null,
      /**
       * Whether the created administrator must change its bootstrap password
       * before the administrator tools open. `false` still records the fact —
       * the account keeps `mustChangePassword`, and the administrator area
       * shows it as a warning — but does not lock the operator out.
       */
      requirePasswordChange: env.ADMIN_BOOTSTRAP_REQUIRE_PASSWORD_CHANGE,
      /**
       * The whole feature is refused in production, so this is only ever true
       * for a local instance that a human is looking at.
       */
      permitted: env.ADMIN_BOOTSTRAP_ENABLED && !isProd,
    },
    isolated: {
      expectedDatabaseName: env.ISOLATED_DATABASE_NAME,
      expectedMediaRoot: env.ISOLATED_MEDIA_ROOT,
    },
    imports: {
      youtubeApiKey: env.YOUTUBE_API_KEY ?? null,
      creatorExportRoot: env.CREATOR_EXPORT_ROOT,
      maxItems: env.IMPORT_MAX_ITEMS,
      maxConcurrency: env.IMPORT_MAX_CONCURRENCY,
      httpTimeoutMs: env.IMPORT_HTTP_TIMEOUT_MS,
      maxResponseBytes: env.IMPORT_MAX_RESPONSE_BYTES,
      storageQuotaBytes: env.STORAGE_QUOTA_BYTES,
    },
  };
}

let cached: AppConfig | null = null;

/** Lazily validated, memoised configuration. */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: drop the memoised config after mutating process.env. */
export function resetConfigCache(): void {
  cached = null;
}

/** Public configuration safe to expose to the browser. */
export function publicConfig() {
  const c = getConfig();
  return {
    appUrl: c.appUrl,
    mediaPublicBase: c.storage.publicBase,
    maxUploadBytes: c.uploads.maxBytes,
    transcodeLadder: c.media.transcodeLadder,
    enableHls: c.media.enableHls,
  };
}
