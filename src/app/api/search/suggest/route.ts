/**
 * Search autocomplete.
 *
 *   GET /api/search/suggest?q=
 *
 * Public (no session needed) and deliberately cheap: the header calls it on
 * every debounced keystroke.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { suggest } from "@/server/services/search";

export const dynamic = "force-dynamic";

const query = z.object({ q: z.string().trim().max(120).default("") });

export async function GET(request: Request) {
  try {
    const { q } = parseQuery(request, query);
    return jsonOk({ suggestions: await suggest(q) });
  } catch (error) {
    return jsonError(error);
  }
}
