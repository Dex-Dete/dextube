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

export function loadEnvFile(file = path.resolve(process.cwd(), ".env")): void {
  if (loaded || process.env.DEXTUBE_SKIP_ENV_FILE === "1") return;
  loaded = true;
  if (!fs.existsSync(file)) return;

  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
