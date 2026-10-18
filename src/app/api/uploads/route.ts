import { assertSameOrigin, jsonCreated, jsonError, jsonOk, parseJson } from "@/lib/http";
import { initiateUploadSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import { LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { initiateUpload } from "@/server/services/uploads";
import { acceptedFormatsSummary, isAcceptedUpload } from "@/server/media/validate";
import { badRequest } from "@/lib/errors";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * POST /api/uploads — reserve an upload slot.
 * Body: `{ filename, sizeBytes, mimeType }`
 * Returns the upload id, the chunk size and the byte offset to start from.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.upload(), user.id);

    const input = await parseJson(request, initiateUploadSchema);
    const check = isAcceptedUpload(input.filename, input.mimeType);
    if (!check.ok) {
      throw badRequest(`${check.reason} Accepted formats: ${acceptedFormatsSummary()}.`);
    }

    const result = await initiateUpload(user.id, input);
    return jsonCreated(result);
  } catch (error) {
    return jsonError(error);
  }
}

/** GET /api/uploads — documents what this instance accepts (shown in the UI). */
export async function GET() {
  const config = getConfig();
  return jsonOk({
    acceptedFormats: acceptedFormatsSummary(),
    maxBytes: config.uploads.maxBytes,
    maxDurationSeconds: config.uploads.maxDurationSeconds,
    chunkSize: 5 * 1024 * 1024,
    transcodeLadder: config.media.transcodeLadder,
    hls: config.media.enableHls,
  });
}
