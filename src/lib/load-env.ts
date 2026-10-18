/**
 * Minimal `.env` loader for standalone Node scripts (worker, seed, tests).
 *
 * Next.js loads `.env` itself for the web app, so this module is a no-op when
 * the variables are already present. It intentionally does not support
 * interpolation or `export` prefixes — DEXTube's `.env.example` does not need
 * them, and a smaller parser is a smaller attack surface.
 */
import fs from "node:fs";
import path from "node:path";

let loaded = false;

/**
 * Resolves the env file to read. `DEXTUBE_ENV_FILE` lets a wrapper point a
 * process at a different file (the isolated test environment uses
 * `.env.isolated-test`); it is resolved relative to the current working
 * directory, exactly like the default.
 */
function defaultEnvFile(): string {
  const override = process.env.DEXTUBE_ENV_FILE;
  return override ? path.resolve(process.cwd(), override) : path.resolve(process.cwd(), ".env");
}

export function loadEnvFile(file = defaultEnvFile()): void {
  if (loaded || process.env.DEXTUBE_SKIP_ENV_FILE === "1") return;
  loaded = true;
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, "utf8");
  applyEnv(source);
}

/**
 * Parses `.env`-style text into a plain map. Never touches `process.env`, so it
 * is safe for reading a *different* file — the reset command uses it to read the
 * development configuration while running under the isolated one.
 */
export function parseEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Reads a `.env`-style file into a map, returning `{}` when it is absent. */
export function readEnvFile(file: string): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Applies `.env`-style text without overriding anything already in `process.env`. */
export function applyEnv(source: string): void {
  for (const [key, value] of Object.entries(parseEnv(source))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}
