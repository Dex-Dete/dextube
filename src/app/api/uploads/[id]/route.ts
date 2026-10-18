import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { abortUpload, getUploadStatus } from "@/server/services/uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/uploads/:id — resumable state for this upload (owner only). */
export async function GET(request: Request, context: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    return jsonOk(await getUploadStatus(id, user.id));
  } catch (error) {
    return jsonError(error);
  }
}

/** DELETE /api/uploads/:id — cancels the upload and removes the partial file. */
export async function DELETE(request: Request, context: Ctx) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await abortUpload(id, user.id);
    return jsonOk({ aborted: true });
  } catch (error) {
    return jsonError(error);
  }
}
