import { expect, type Page } from "@playwright/test";

/** A per-run unique suffix so parallel/back-to-back runs never collide. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface TestAccount {
  username: string;
  email: string;
  password: string;
  displayName: string;
  /** Channel handle, resolved from the session after registration. */
  handle: string;
}

export function makeAccount(): TestAccount {
  const suffix = uniqueSuffix();
  return {
    username: `e2e_${suffix}`,
    email: `e2e-${suffix}@example.test`,
    password: "CorrectHorse1",
    displayName: `E2E ${suffix}`,
    handle: "",
  };
}

/** Registers through the real form and waits until the session is live. */
export async function register(page: Page, account = makeAccount()): Promise<TestAccount> {
  await page.goto("/register");
  await page.locator('input[name="displayName"]').fill(account.displayName);
  await page.locator('input[name="username"]').fill(account.username);
  await page.locator('input[name="email"]').fill(account.email);
  await page.locator('input[name="password"]').fill(account.password);
  // The register form has a confirm field; fill it if present.
  const confirm = page.locator('input[name="confirm"]');
  if (await confirm.count()) await confirm.fill(account.password);
  await page.getByRole("button", { name: /create account|sign up|register/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 30_000 });

  // Confirm the session cookie works.
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBeTruthy();
  const body = (await session.json()) as {
    user?: { username?: string; channel?: { handle?: string } | null } | null;
  };
  expect(body.user?.username).toBe(account.username);
  account.handle = body.user?.channel?.handle ?? "";
  expect(account.handle).not.toBe("");
  return account;
}
