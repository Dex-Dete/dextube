import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { appendChunk } from "@/server/services/uploads";
import { badRequest, payloadTooLarge } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Maximum accepted chunk, with a little headroom over the advertised size. */
const HARD_CHUNK_LIMIT = 8 * 1024 * 1024;

/**
 * PUT /api/uploads/:id/chunk?offset=N
 *
 * Body: raw bytes (`application/octet-stream`). The offset is explicit and
 * monotonic, so a retried or resumed chunk is idempotent from the client's
 * point of view: the server replies 409 with the authoritative offset if the
 * client's view of the world is stale.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;

    const offsetParam = new URL(request.url).searchParams.get("offset");
    const offset = Number(offsetParam);
    if (offsetParam === null || !Number.isInteger(offset) || offset < 0) {
      throw badRequest("A non-negative integer `offset` query parameter is required.");
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > HARD_CHUNK_LIMIT) throw payloadTooLarge("Chunk too large.");

    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length > HARD_CHUNK_LIMIT) throw payloadTooLarge("Chunk too large.");

    const result = await appendChunk(id, user.id, offset, buffer);
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
