/**
 * A channel's videos (used by the channel page's "load more").
 *
 *   GET /api/channels/:handle/videos?tab=videos|shorts|popular|all&cursor=&limit=
 *
 * Public and anonymous-friendly. The owner sees their own unlisted videos here
 * only when signed in as the channel owner; everyone else sees PUBLIC + READY.
 */
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { z } from "zod";
import { getViewerContext } from "@/server/auth/session";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { getChannelVideos } from "@/server/services/videos";
import { paginationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const query = paginationSchema.extend({
  tab: z.enum(["videos", "shorts", "popular", "all"]).default("videos"),
});

export async function GET(request: Request, context: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await context.params;
    const { tab, cursor, limit } = parseQuery(request, query);

    const channel = await prisma.channel.findUnique({
      where: { handle: handle.toLowerCase() },
      select: { id: true },
    });
    if (!channel) throw notFound("That channel does not exist.");

    const viewer = await getViewerContext();
    const page = await getChannelVideos({
      channelId: channel.id,
      viewerChannelId: viewer.channelId,
      tab,
      cursor,
      limit,
      includeOwnUnpublished: true,
    });
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}
