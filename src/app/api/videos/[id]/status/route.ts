import { jsonError, jsonOk } from "@/lib/http";
import { getCurrentUser } from "@/server/auth/session";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/videos/:id/status
 *
 * Lightweight processing-status poll used by the uploader. Returns just enough
 * for the client: status, error, and whether the video is playable. Access is
 * limited to the owning channel so a private video's state never leaks.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    const { id } = await context.params;

    const video = await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        visibility: true,
        processingError: true,
        thumbnailKey: true,
        playbackKey: true,
        durationSec: true,
        isShort: true,
        channelId: true,
      },
    });
    if (!video) throw notFound("That video does not exist.");

    const isOwner = Boolean(user?.channel && user.channel.id === video.channelId);
    // Non-owners may only see public/unlisted, ready videos.
    if (!isOwner && (video.visibility === "PRIVATE" || video.status !== "READY")) {
      throw notFound("That video does not exist.");
    }

    return jsonOk({
      id: video.id,
      status: video.status,
      visibility: video.visibility,
      isShort: video.isShort,
      durationSec: video.durationSec,
      thumbnailKey: video.thumbnailKey,
      playable: video.status === "READY" && Boolean(video.playbackKey),
      ...(isOwner ? { processingError: video.processingError } : {}),
    });
  } catch (error) {
    return jsonError(error);
  }
}
