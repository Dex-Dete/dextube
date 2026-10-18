/**
 * `npm run doctor` — preflight diagnostic for self-hosters.
 *
 * Checks, in order, everything that commonly breaks a fresh install:
 *   1. Node version
 *   2. `.env` presence and required secrets
 *   3. PostgreSQL connectivity + migration state
 *   4. Media storage directory writability
 *   5. FFmpeg / FFprobe presence
 *   6. A real H.264 encoder (the #1 Fedora gotcha)
 *   7. SMTP configuration (optional, reported as a warning)
 *
 * Exits non-zero when a hard requirement is unmet so it can gate `start.sh`.
 *
 *   npm run doctor
 */
import { loadEnvFile } from "../src/lib/load-env";

loadEnvFile();

interface Check {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}

const checks: Check[] = [];
const ok = (name: string, detail: string) => checks.push({ name, level: "ok", detail });
const warn = (name: string, detail: string) => checks.push({ name, level: "warn", detail });
const fail = (name: string, detail: string) => checks.push({ name, level: "fail", detail });

async function main() {
  // ---------------------------------------------------------------- 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok("Node.js", `v${process.versions.node}`);
  else fail("Node.js", `v${process.versions.node} — DEXTube needs Node 22 or newer.`);

  // ----------------------------------------------------------------- 2. env
  let config: Awaited<ReturnType<typeof import("../src/lib/config").getConfig>> | null = null;
  try {
    const { getConfig } = await import("../src/lib/config");
    config = getConfig();
    ok("Configuration", "all required environment variables are present and valid");
    if (config.email.configured) ok("Email (SMTP)", `configured via ${config.email.host}`);
    else warn("Email (SMTP)", "not configured — verification/reset links are written to storage/mail-outbox/");
    if (config.media.enableHls) ok("HLS", "enabled");
    else warn("HLS", "disabled (ENABLE_HLS=false) — progressive MP4 playback only");
  } catch (error) {
    fail("Configuration", error instanceof Error ? error.message.split("\n")[0] : String(error));
  }

  // ------------------------------------------------------------ 3. database
  if (config) {
    try {
      const { prisma } = await import("../src/lib/db");
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      const applied = Number(rows[0]?.count ?? 0);
      const users = await prisma.user.count();
      const videos = await prisma.video.count();
      ok("PostgreSQL", `connected, ${applied} migration(s) applied, ${users} user(s), ${videos} video(s)`);
    } catch (error) {
      fail(
        "PostgreSQL",
        `${error instanceof Error ? error.message.split("\n").slice(-1)[0] : String(error)} — is the database running? Try: scripts/db-up.sh`,
      );
    }
  }

  // ------------------------------------------------------------- 4. storage
  if (config) {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const root = path.resolve(process.cwd(), config.storage.mediaRoot);
      await fs.mkdir(root, { recursive: true });
      const probeFile = path.join(root, ".doctor-write-test");
      await fs.writeFile(probeFile, "ok");
      await fs.rm(probeFile, { force: true });
      const stat = await fs.statfs(root);
      const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1024 ** 3;
      ok(
        "Media storage",
        `${root} is writable (${freeGb.toFixed(1)} GiB free, driver: ${config.storage.driver})`,
      );
      if (config.storage.driver === "s3") {
        warn("Storage driver", "STORAGE_DRIVER=s3 is not implemented in this release; uploads will fail. Use local.");
      }
      if (freeGb < 5) warn("Disk space", `only ${freeGb.toFixed(1)} GiB free — transcoding needs headroom`);
    } catch (error) {
      fail("Media storage", error instanceof Error ? error.message : String(error));
    }
  }

  // --------------------------------------------------------------- 5-6. media
  try {
    const { checkMediaTools } = await import("../src/server/media/ffmpeg");
    const tools = await checkMediaTools();
    if (tools.ffmpeg.available) ok("FFmpeg", tools.ffmpeg.version ?? "available");
    else fail("FFmpeg", `not runnable (${tools.ffmpeg.error ?? "unknown"}) — install ffmpeg-free`);
    if (tools.ffprobe.available) ok("FFprobe", tools.ffprobe.version ?? "available");
    else fail("FFprobe", `not runnable (${tools.ffprobe.error ?? "unknown"})`);

    if (tools.encoder && tools.encoder.id !== "none") {
      ok(
        "H.264 encoder",
        `${tools.encoder.id} (${tools.encoder.hardware ? "hardware" : "software"}) — ${tools.encoder.detail}`,
      );
    } else {
      fail(
        "H.264 encoder",
        "none found. Install ffmpeg-free (Fedora, provides libopenh264) or RPM Fusion's ffmpeg (provides libx264).",
      );
    }
  } catch (error) {
    fail("Media tools", error instanceof Error ? error.message.split("\n")[0] : String(error));
  }

  // ----------------------------------------------------------------- report
  const symbol = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
  console.log("\nDEXTube preflight\n" + "─".repeat(64));
  for (const check of checks) {
    console.log(`  [${symbol[check.level]}] ${check.name.padEnd(18)} ${check.detail}`);
  }
  const failures = checks.filter((c) => c.level === "fail").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  console.log("─".repeat(64));
  console.log(`  ${checks.length - failures - warnings} passed, ${warnings} warning(s), ${failures} failure(s)\n`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error("doctor crashed:", error);
  process.exitCode = 1;
});
