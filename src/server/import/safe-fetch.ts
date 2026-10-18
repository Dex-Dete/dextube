/**
 * SSRF-hardened HTTP client for the import connectors.
 *
 * DEXTube lets an administrator paste a channel or playlist URL. That is a
 * classic server-side request forgery primitive, so every outbound request made
 * on the operator's behalf goes through this module, which enforces:
 *
 *   * **HTTPS only.** No `file:`, `data:`, `gopher:` or plain HTTP.
 *   * **A host allowlist.** The caller names the hosts it is willing to talk to;
 *     anything else is refused before a socket is opened. There is no "fetch
 *     arbitrary URL" entry point in DEXTube.
 *   * **Port 443 only.** A URL may not redirect the fetcher at `:22` or `:6379`.
 *   * **No private address space.** Every DNS answer is resolved *before*
 *     connecting and rejected if any address is loopback, private, link-local,
 *     CGNAT, multicast or otherwise reserved. This is what stops
 *     `https://youtube.com@127.0.0.1/` style tricks and DNS rebinding to
 *     `169.254.169.254` (the cloud metadata endpoint).
 *   * **Manual redirects.** Each hop is validated from scratch, and the chain is
 *     capped, so a 302 cannot smuggle the request into a forbidden host.
 *   * **A timeout and a byte ceiling.** A slow or endless response cannot pin a
 *     worker; the body is read through a counting reader and abandoned once it
 *     exceeds the limit.
 *
 * Honest limitation: DNS is resolved once and Node re-resolves when connecting,
 * so a hostile authoritative DNS server could in principle answer differently on
 * the second lookup (a TOCTOU rebinding race). Pinning the connect address
 * requires a custom agent; the allowlist above means the only hosts reachable
 * are the ones an administrator already trusts, and the private-range check
 * makes a rebind fail closed for the overwhelmingly common case. This is
 * documented rather than hidden.
 */
import "server-only";
import { promises as dns } from "node:dns";
import net from "node:net";
import { AppError } from "@/lib/errors";

const DEFAULT_USER_AGENT = "DEXTube-metadata/1.0 (+https://github.com/DEXTube)";

export interface SafeFetchOptions {
  /**
   * Hostnames the request may touch. `example.com` matches only that host;
   * `.example.com` matches it and every subdomain.
   */
  allowHosts: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  /** Redirect hops allowed. Each hop is re-validated. */
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  body: string;
  contentType: string | null;
}

function blocked(message: string): AppError {
  return new AppError("FORBIDDEN", message);
}

/** True when `host` is covered by one of the allowlist entries. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith(".")) return h === e.slice(1) || h.endsWith(e);
    return h === e;
  });
}

/**
 * Rejects addresses an administrator's request must never reach.
 * Written as explicit ranges rather than a library dependency so the policy is
 * readable and reviewable in one place.
 */
export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map((n) => Number(n));
    if (a === undefined || b === undefined) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // 198.51.100.0/24
    if (a === 203 && b === 0) return true; // 203.0.113.0/24
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower.startsWith("fe80") || lower.startsWith("fec0")) return true; // link-local
    if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("2001:db8")) return true; // documentation
    if (lower.startsWith("64:ff9b")) return true; // NAT64
    return false;
  }
  return true; // not an IP at all
}

/** Validates one URL and confirms every DNS answer points somewhere public. */
async function assertSafeUrl(rawUrl: string, allowHosts: readonly string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw blocked("That address is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw blocked("Only https:// addresses are accepted.");
  }
  if (url.username || url.password) {
    throw blocked("Credentials are not allowed in an import URL.");
  }
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== 443) {
    throw blocked("Only the default https port (443) is accepted.");
  }
  if (!hostAllowed(url.hostname, allowHosts)) {
    throw blocked(`Importing from "${url.hostname}" is not permitted.`);
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError("PRECONDITION_FAILED", `Could not resolve "${url.hostname}".`);
  }
  if (answers.length === 0) {
    throw new AppError("PRECONDITION_FAILED", `"${url.hostname}" did not resolve to any address.`);
  }
  for (const answer of answers) {
    if (isBlockedAddress(answer.address)) {
      throw blocked(`"${url.hostname}" resolves to a non-public address and will not be contacted.`);
    }
  }
  return url;
}

/** Reads at most `maxBytes` from a response body, then gives up. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", "The remote document is larger than the import limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError("PAYLOAD_TOO_LARGE", "The remote document is larger than the import limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches a text document under the policy described at the top of this file.
 * Throws `AppError` for anything refused; never returns a partial document.
 */
export async function safeFetchText(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let current = rawUrl;
    for (let hop = 0; ; hop++) {
      const url = await assertSafeUrl(current, options.allowHosts);
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
            accept: options.accept ?? "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5",
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AppError("PRECONDITION_FAILED", "The remote server took too long to respond.");
        }
        throw new AppError(
          "PRECONDITION_FAILED",
          `Could not reach "${url.hostname}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= maxRedirects) {
          throw blocked("The remote server redirected too many times.");
        }
        await response.body?.cancel().catch(() => {});
        current = new URL(location, url).toString();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(
          "PRECONDITION_FAILED",
          `The remote server answered ${response.status} for that address.`,
        );
      }

      const body = await readCapped(response, options.maxBytes);
      return {
        status: response.status,
        finalUrl: url.toString(),
        body,
        contentType: response.headers.get("content-type"),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper for JSON endpoints (the YouTube Data API v3). */
export async function safeFetchJson<T>(url: string, options: SafeFetchOptions): Promise<T> {
  const result = await safeFetchText(url, { ...options, accept: "application/json" });
  try {
    return JSON.parse(result.body) as T;
  } catch {
    throw new AppError("PRECONDITION_FAILED", "The remote server did not return valid JSON.");
  }
}
