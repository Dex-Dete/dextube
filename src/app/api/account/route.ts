/**
 * Account.
 *
 *   PATCH /api/account   { displayName?, bio?, username? }   profile edit
 *   DELETE /api/account  { password, confirm: "DELETE" }      delete account
 *
 * Profile edits go through the accounts service; deleting an account requires
 * the password again and anonymises content rather than orphaning rows.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser, revokeCurrentSession } from "@/server/auth/session";
import { deleteAccount, updateProfile } from "@/server/services/accounts";
import { deleteAccountSchema, updateProfileSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, updateProfileSchema);
    await updateProfile(user.id, input);
    return jsonOk({ updated: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.sensitive(), user.id);
    const { password, confirm } = await parseJson(request, deleteAccountSchema);
    const result = await deleteAccount(user.id, password, confirm);
    await revokeCurrentSession();
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
