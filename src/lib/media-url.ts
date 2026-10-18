/**
 * Builds browser-facing URLs for stored media keys.
 *
 * Media is always served through DEXTube's own endpoint
 * (`/api/media/<key>`) so that visibility rules, range requests and MIME
 * sniffing are enforced server-side. Stored keys are opaque; the client never
 * sees a filesystem path.
 */
export function mediaUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  return `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** URL used by the <video> element; `?download=1` forces a download disposition. */
export function streamUrl(key: string | null | undefined, opts?: { download?: boolean }): string | null {
  const base = mediaUrl(key);
  if (!base) return null;
  return opts?.download ? `${base}?download=1` : base;
}
