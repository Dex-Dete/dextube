import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { register } from "./helpers";

/**
 * The administrator area, tested from outside.
 *
 * The service-level rules (bootstrap creates the account, disabling revokes
 * sessions, the bootstrap cannot be re-armed from the web) are covered by
 * `tests/integration/admin-bootstrap.test.ts`. What can only be checked through
 * a browser and real HTTP is the *boundary* and the *pages*:
 *
 *   - a signed-out visitor and an ordinary signed-in user must not reach an
 *     administrator surface, and must not be able to read its data out of the
 *     response;
 *   - a real administrator must actually see the real content.
 *
 * The second point is why the "no data leaks" assertions below look at the
 * response body rather than the status code. App Router streams a page in
 * parallel with its layout, so a rejected visitor gets the not-found UI with a
 * `200` status — an earlier version of this area served the audit trail in that
 * body. Asserting on the status would have missed it; asserting on the body
 * catches it.
 */

/** The administrator credentials, read from the switch file the operator edits. */
interface AdminSwitch {
  enabled: boolean;
  username: string;
  password: string;
}

function readAdminSwitch(): AdminSwitch {
  try {
    const text = readFileSync("Admintruefalse.md", "utf8");
    const value = (key: string): string | null => {
      const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(text);
      return match?.[1]?.replace(/^[`"']|[`"']$/g, "").trim() ?? null;
    };
    return {
      enabled: value("admin") === "true",
      username: value("username") ?? "admin",
      password: value("password") ?? "",
    };
  } catch {
    return { enabled: false, username: "admin", password: "" };
  }
}

const ADMIN = readAdminSwitch();

/**
 * Signs the administrator in through the real endpoint, on a context, so the
 * browser and the API share one session exactly as a person's would.
 */
async function signInAsAdmin(context: import("@playwright/test").BrowserContext, baseURL: string): Promise<void> {
  const response = await context.request.post("/api/auth/login", {
    headers: { Origin: baseURL },
    data: { identifier: ADMIN.username, password: ADMIN.password },
  });
  expect(response.ok(), `administrator sign-in returned ${response.status()}`).toBeTruthy();
}

const ADMIN_PAGES = ["/admin", "/admin/users", "/admin/system", "/admin/import", "/admin/jobs"] as const;
/** Phrases that only exist on a rendered administrator page. */
const ADMIN_ONLY_PHRASES = [
  "Administration overview",
  "Bootstrap (env)",
  "Recent audit log",
  "Administrator user list",
] as const;

test.describe("administrator surface", () => {
  test("is invisible to a signed-out visitor", async ({ page }) => {
    for (const path of ADMIN_PAGES) {
      const response = await page.goto(path);
      const body = (await response?.text()) ?? "";
      // Not the area itself...
      for (const phrase of ADMIN_ONLY_PHRASES) {
        expect(body, `${path} must not render "${phrase}"`).not.toContain(phrase);
      }
      // ...and not the administrator's data either. The refusal is rendered, but
      // the layout gate runs in parallel with the page, so the only proof that
      // nothing was serialised is the absence of real values in the response.
      expect(body, `${path} must not leak audit actions`).not.toContain("admin.bootstrap.create");
      expect(body, `${path} must not leak the source URL`).not.toContain("youtube.com/@MrBeast");
      // The visitor is shown the not-found page.
      await expect(page.getByText("This page could not be found", { exact: false })).toBeVisible();
    }

    // The API answers with the error envelope: a guarded handler, not a missing
    // route (which would be a bodyless 404).
    for (const path of ["/api/admin/users", "/api/admin/audit"]) {
      const response = await page.request.get(path);
      expect(response.status(), `${path} must refuse an anonymous reader`).toBe(401);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
    }
  });

  test("refuses an ordinary signed-in user and leaks nothing", async ({ page }) => {
    await register(page);

    for (const path of ADMIN_PAGES) {
      const response = await page.goto(path);
      const body = (await response?.text()) ?? "";
      for (const phrase of ADMIN_ONLY_PHRASES) {
        expect(body, `${path} must not render "${phrase}" for a normal user`).not.toContain(phrase);
      }
      expect(body, `${path} must not leak audit actions`).not.toContain("admin.bootstrap.create");
      await expect(page.getByText("This page could not be found", { exact: false })).toBeVisible();
    }

    for (const path of ["/api/admin/users", "/api/admin/audit"]) {
      const response = await page.request.get(path);
      expect(response.status(), `${path} must refuse a non-administrator`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("FORBIDDEN");
      expect(JSON.stringify(body)).not.toMatch(/passwordHash/);
    }

    const patch = await page.request.patch("/api/admin/settings", {
      headers: { Origin: new URL(page.url()).origin },
      data: { adminBootstrapEnabled: true },
    });
    expect(patch.status(), "a non-administrator must not change settings").not.toBe(200);

    // The refusal left no trace on the account.
    const session = await page.request.get("/api/auth/session");
    expect(((await session.json()) as { user?: { role?: string } }).user?.role).toBe("USER");
  });
});

/**
 * The positive path, driven by the credentials in `Admintruefalse.md`. It is
 * skipped when the switch says the administrator should not exist, so the suite
 * stays honest whether or not you have switched the account on.
 */
test.describe("administrator pages", () => {
  test.skip(!ADMIN.enabled, "Admintruefalse.md does not say `admin: true`.");

  test("signs in and shows the real pages, including the imported entries", async ({ browser, baseURL }) => {
    const origin = baseURL ?? "http://localhost:3000";
    const context = await browser.newContext({ baseURL: origin });
    await signInAsAdmin(context, origin);
    const page = await context.newPage();

    try {
      // The overview renders real server data.
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Administration overview" })).toBeVisible();
      await expect(page.getByText("Bootstrap (env)")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Recent audit log" })).toBeVisible();
      // The audit trail is real: the account was created by the bootstrap.
      await expect(page.getByText("admin.bootstrap.create")).toBeVisible();

      // Users, system and import are all reachable.
      await page.goto("/admin/users");
      await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

      await page.goto("/admin/system");
      await expect(page.getByRole("heading", { name: "System settings" })).toBeVisible();

      await page.goto("/admin/jobs");
      await expect(page.getByRole("heading", { name: "Processing jobs" })).toBeVisible();

      // The import page, showing the real imported channel.
      await page.goto("/admin/import");
      await expect(page.getByRole("heading", { name: "Import", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /YouTube ownership OAuth|Verify YouTube ownership/ })).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Import storage used" })).toBeVisible();
      await expect(page.getByText(/configured import capacity/)).toBeVisible();

      // A clean development reset has no import history. If an operator later
      // runs the metadata import, the same page exposes and verifies the real
      // entries below.
      const hasMrBeast = (await page.getByText("MrBeast").count()) > 0;
      if (!hasMrBeast) {
        await expect(page.getByText("No imports yet.")).toBeVisible();
        return;
      }
      await expect(page.getByText("MrBeast").first()).toBeVisible();

      // The ten entries. They are metadata-only by design (no permission to copy
      // the media), so the assertion is on the real published titles, and on the
      // status vocabulary that says plainly what was and was not copied.
      const titles = [
        "Lose 150 Lbs Together, Win $250,000",
        "Last To Fall Wins",
        "Giving $10,000 To A Random Subscriber",
        "Eat Everything In A Grocery Store, Win $1,000,000",
        "What’s Inside My Briefcase?",
        "I Built A City To Save Kids From Illegal Labor",
        "Can We Build an Entire Village?",
        "I Survived The Most Extreme Places On Earth",
        "World’s Largest Tennis Match",
        "Escape 100 Cops, Win $500,000",
      ];

      const showing = page.getByRole("button", { name: "View entries" }).first();
      await showing.click();
      await expect(page.getByLabel(/Import progress:/).first()).toBeVisible();
      for (const title of titles) {
        await expect(page.getByText(title, { exact: false }).first(), `"${title}" must be listed`).toBeVisible();
      }
      // No favourite framings: the entries state that only metadata was stored.
      await expect(page.getByText(/metadata only|METADATA_ONLY/i).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
