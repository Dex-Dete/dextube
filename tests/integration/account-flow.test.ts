import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import {
  authenticate,
  changePassword,
  issueToken,
  registerUser,
  verifyEmail,
} from "@/server/services/accounts";
import { cleanupFixtures, createTestUser, uniqueSuffix } from "./helpers";

const dbOk = (await checkDatabase()).ok;

afterAll(async () => {
  if (dbOk) await cleanupFixtures();
});

describe.skipIf(!dbOk)("account lifecycle (database)", () => {
  it("registers an account with a channel and authenticates it", async () => {
    const user = await createTestUser();

    const channel = await prisma.channel.findUnique({ where: { id: user.channelId } });
    expect(channel?.handle).toBe(user.handle);

    const byUsername = await authenticate(user.username, user.password);
    expect(byUsername?.id).toBe(user.userId);
    const byEmail = await authenticate(user.email, user.password);
    expect(byEmail?.id).toBe(user.userId);
  });

  it("returns null for a wrong password or an unknown identifier", async () => {
    const user = await createTestUser();
    expect(await authenticate(user.username, "definitely-wrong")).toBeNull();
    expect(await authenticate(`nobody-${uniqueSuffix()}`, user.password)).toBeNull();
  });

  it("rejects a duplicate email address", async () => {
    const user = await createTestUser();
    await expect(
      registerUser({
        username: `itest_${uniqueSuffix()}`,
        displayName: "Copycat",
        email: user.email,
        password: "CorrectHorse1",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("verifies an email address with a single-use token", async () => {
    const user = await createTestUser();
    const issued = await issueToken(user.userId, "EMAIL_VERIFICATION");
    const raw = new URL(issued.link).searchParams.get("token")!;

    const result = await verifyEmail(raw);
    expect(result.userId).toBe(user.userId);

    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { emailVerifiedAt: true },
    });
    expect(fresh.emailVerifiedAt).not.toBeNull();

    // Single use: replaying the same token must fail.
    await expect(verifyEmail(raw)).rejects.toThrow(/invalid or has expired|already been used/i);
  });

  it("changes the password and invalidates the old one", async () => {
    const user = await createTestUser();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { sessionEpoch: true },
    });

    await changePassword(user.userId, user.password, "NewCorrectHorse2");

    expect(await authenticate(user.username, user.password)).toBeNull();
    expect((await authenticate(user.username, "NewCorrectHorse2"))?.id).toBe(user.userId);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { sessionEpoch: true },
    });
    // Changing the password bumps the epoch so every existing session dies.
    expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);
  });
});
