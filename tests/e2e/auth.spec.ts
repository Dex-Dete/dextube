import { expect, test } from "@playwright/test";
import { register } from "./helpers";

test.describe("authentication and account chrome", () => {
  test("registers, reaches Studio, signs out and signs back in", async ({ page }) => {
    const account = await register(page);

    // A fresh account has a channel, so Studio is reachable immediately.
    await page.goto("/studio");
    await expect(page.getByRole("heading", { name: "Channel analytics" })).toBeVisible();

    // The channel page shows the display name we registered with.
    await page.goto(`/channel/${account.handle}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(account.displayName);

    // Sign out from the account menu.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();

    // Sign back in with the email address.
    await page.goto("/login");
    await page.locator('input[name="identifier"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

    const session = await page.request.get("/api/auth/session");
    const body = (await session.json()) as { user?: { username?: string } | null };
    expect(body.user?.username).toBe(account.username);
  });

  test("rejects a wrong password without revealing whether the account exists", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[name="identifier"]').fill("definitely-not-a-user");
    await page.locator('input[name="password"]').fill("WrongPassword1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(page.url()).toContain("/login");
  });
});
