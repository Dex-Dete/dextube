/**
 * Media delivery.
 *
 * Every stored object is served through this route so that:
 *   * privacy is enforced per request (a private video's media is a 404 for
 *     anyone but its owning channel),
 *   * HTTP range requests work, which is what makes `<video>` seeking and
 *     progressive playback possible,
 *   * the correct MIME type is always sent with `X-Content-Type-Options:
 *     nosniff`, so an uploaded file can never be interpreted as HTML/JS,
 *   * storage keys never appear as filesystem paths.
 */
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStorage, mimeForExtension, normalizeKey } from "@/server/storage";
import { getCurrentUser } from "@/server/auth/session";
import { authorizeTrackDownload } from "@/server/services/music";
import { jsonError } from "@/lib/http";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Keys under these prefixes are public assets (avatars, banners). */
const PUBLIC_PREFIXES = ["images/", "channels/", "users/"];

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return serve(request, context, false);
}

/** HEAD returns the same headers (length, ranges, type) without a body. */
export async function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return serve(request, context, true);
}

async function serve(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
  headOnly: boolean,
): Promise<Response> {
  try {
    const { path } = await context.params;
    let key: string;
    try {
      key = normalizeKey(path.map(decodeURIComponent).join("/"));
    } catch {
      throw notFound("Media not found.");
    }

    const user = await getCurrentUser();
    const allowed = await authorize(key, user?.id ?? null, user?.channel?.id ?? null);
    if (!allowed) throw notFound("Media not found.");

    const storage = getStorage();
    const stat = await storage.stat(key);
    if (!stat) throw notFound("Media not found.");

    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const contentType = mimeForExtension(key);

    // A track's bytes are playable under the visibility rules, but a *download*
    // is an additional right granted by the track's licence. Enforcing it here
    // — on the one route that serves the bytes — means `?download=1` cannot
    // bypass the rights metadata.
    if (download && key.startsWith("tracks/")) {
      const trackId = key.split("/")[1];
      if (!trackId) throw notFound("Media not found.");
      await authorizeTrackDownload(trackId, {
        channelId: user?.channel?.id ?? null,
        role: user?.role ?? "USER",
      });
    }

    const baseHeaders: Record<string, string> = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      // Media is immutable-by-key: a new upload gets a new key.
      "cache-control": allowed === "private" ? "private, max-age=300" : "public, max-age=31536000, immutable",
      ...(download ? { "content-disposition": `attachment; filename="${safeFilename(key)}"` } : {}),
    };

    const rangeHeader = request.headers.get("range");
    if (rangeHeader && !download) {
      const range = parseRange(rangeHeader, stat.size);
      if (range === "invalid") {
        return new NextResponse(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}`, "accept-ranges": "bytes" },
        });
      }
      if (range) {
        const length = range.end - range.start + 1;
        const headers = {
          ...baseHeaders,
          "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
          "content-length": String(length),
        };
        if (headOnly) return new NextResponse(null, { status: 206, headers });
        const stream = await storage.getStream(key, range);
        return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
      }
    }

    const headers = { ...baseHeaders, "content-length": String(stat.size) };
    if (headOnly || request.method === "HEAD") return new NextResponse(null, { status: 200, headers });

    // Local driver: stream straight from disk. (A remote driver would return a
    // redirect or a proxied stream from the same interface.)
    const stream = await storage.getStream(key);
    return new NextResponse(Readable.toWeb(stream as unknown as Readable) as ReadableStream, { status: 200, headers });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Returns `true`, `"private"` or `false`.
 *
 *  * `images/`, `channels/`, `users/` — public branding assets.
 *  * `videos/:id/...` — follows the video's visibility: PUBLIC and UNLISTED are
 *    readable by anyone with the key, PRIVATE only by the owning channel.
 *  * `uploads/:id/...` — staging files, owner only.
 */
async function authorize(key: string, userId: string | null, channelId: string | null): Promise<boolean | "private"> {
  if (PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;

  if (key.startsWith("videos/")) {
    const videoId = key.split("/")[1];
    if (!videoId) return false;
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { visibility: true, channelId: true, deletedAt: true },
    });
    if (!video || video.deletedAt) return false;
    if (channelId && channelId === video.channelId) return "private";
    if (video.visibility === "PRIVATE") {
      // Signed-in users who are moderators/admins may review reported media.
      if (!userId) return false;
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      return user && user.role !== "USER" ? "private" : false;
    }
    return video.visibility === "PUBLIC" ? true : "private";
  }

  if (key.startsWith("uploads/")) {
    const uploadId = key.split("/")[1];
    if (!uploadId || !userId) return false;
    const upload = await prisma.upload.findUnique({ where: { id: uploadId }, select: { userId: true } });
    return upload?.userId === userId ? "private" : false;
  }

  if (key.startsWith("tracks/")) {
    // Music follows the same visibility rule as video: PUBLIC and UNLISTED are
    // readable by anyone with the key, PRIVATE only by the owning channel (or a
    // moderator/admin reviewing it). Download rights are checked separately in
    // `serve()`.
    const trackId = key.split("/")[1];
    if (!trackId) return false;
    const track = await prisma.track.findUnique({
      where: { id: trackId },
      select: { visibility: true, channelId: true, deletedAt: true },
    });
    if (!track || track.deletedAt) return false;
    if (channelId && channelId === track.channelId) return "private";
    if (track.visibility === "PRIVATE") {
      if (!userId) return false;
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      return user && user.role !== "USER" ? "private" : false;
    }
    return track.visibility === "PUBLIC" ? true : "private";
  }

  if (key.startsWith("health/")) return false;

  // Unknown prefixes are not served.
  return false;
}

function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";

  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "invalid";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "invalid";
  return { start, end };
}

function safeFilename(key: string): string {
  const base = key.split("/").pop() ?? "download";
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}
