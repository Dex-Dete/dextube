import { z } from "zod";
import { assertSameOrigin, jsonCreated, jsonError, parseJson } from "@/lib/http";
import { categorySchema, tagSchema, visibilitySchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import { completeUpload } from "@/server/services/uploads";
import { kickInlineQueue } from "@/server/jobs/runner";
import { prisma } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

const body = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120, "Title must be at most 120 characters."),
  description: z.string().trim().max(20000).optional(),
  visibility: visibilitySchema.default("PRIVATE"),
  category: categorySchema.optional(),
  tags: z.array(tagSchema).max(20).optional(),
});

/**
 * POST /api/uploads/:id/complete
 *
 * Validates that every byte arrived, probes the file, creates the Video and
 * queues processing. The video only becomes visible once processing succeeds.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;

    const upload = await prisma.upload.findUnique({ where: { id }, select: { userId: true } });
    if (!upload) throw notFound("That upload does not exist.");
    if (upload.userId !== user.id) throw forbidden("That upload belongs to another account.");

    const input = await parseJson(request, body);
    const result = await completeUpload(id, user.id, {
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      category: input.category,
      tags: input.tags,
    });

    // In inline mode, start processing right away so a single-process
    // development setup behaves like a real deployment.
    kickInlineQueue();

    return jsonCreated(result);
  } catch (error) {
    return jsonError(error);
  }
}
