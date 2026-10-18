import path from "node:path";
import { expect, test as base, type BrowserContextOptions, type Page } from "@playwright/test";
import { register } from "./helpers";

/**
 * The video player.
 *
 * DEXTube replaces the browser's native control bar with its own layer on top
 * of a plain `<video>` element, so these tests drive the player the way a viewer
 * would: click play, open the settings menu, pick a quality, change the speed,
 * use the keyboard, and come back later to resume.
 *
 * Everything asserted here is a real measurement taken from the live element —
 * `currentTime`, `playbackRate`, `paused`, the resolved `src` and the HTTP
 * response for that `src`. Nothing is asserted from a mock, and the quality list
 * is read back from the menu rather than assumed.
 */

const SETTINGS = "Settings";

/** Mirrors the base URL resolution in `playwright.config.ts`. */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/**
 * One registration for the whole file.
 *
 * Registration is rate-limited to five accounts per hour per IP, so a
 * signed-in session is created once and shared. Every test then starts already
 * authenticated, which is also closer to how a returning viewer experiences the
 * player.
 */
const test = base.extend<object, { playerStorage: BrowserContextOptions["storageState"] }>({
  playerStorage: [
    async ({ browser }, provide) => {
      // A context created straight from the browser does not inherit the
      // project's `use` options, so the base URL is passed explicitly.
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      await register(page);
      const state = await context.storageState();
      await context.close();
      await provide(state);
    },
    { scope: "worker" },
  ],
  storageState: async ({ playerStorage }, provide) => {
    await provide(playerStorage);
  },
});

/** Open a public video that has been given more than one stored rendition. */
async function openWatchPageWithRenditions(page: Page): Promise<{ id: string; labels: string[] }> {
  const response = await page.request.get("/api/feed?tab=home&limit=8");
  expect(response.ok()).toBe(true);
  const feed = (await response.json()) as { items: { id: string }[] };
  expect(feed.items.length).toBeGreaterThan(0);

  for (const item of feed.items) {
    await page.goto(`/watch/${item.id}`);
    await page.getByRole("button", { name: SETTINGS }).click();
    const qualityRow = page.getByRole("menuitem", { name: /Quality/ });
    await expect(qualityRow).toBeVisible();
    await qualityRow.click();
    const options = page.getByRole("menuitemradio");
    const count = await options.count();
    if (count >= 2) {
      const labels = (await options.allInnerTexts()).map((text) => text.trim());
      await page.getByRole("button", { name: SETTINGS }).click(); // close the menu
      return { id: item.id, labels };
    }
    await page.getByRole("button", { name: SETTINGS }).click();
  }

  throw new Error(
    "No video with more than one stored rendition was found in the home feed; " +
      "run `npm run make:renditions` before the end-to-end suite.",
  );
}

/** Read the live media element's state. */
async function mediaState(page: Page) {
  return page.locator("video").first().evaluate((element) => {
    const video = element as HTMLVideoElement;
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      playbackRate: video.playbackRate,
      src: video.getAttribute("src"),
      hasNativeControls: video.hasAttribute("controls"),
    };
  });
}

/** Open a video from the home feed (the first by default). */
async function openFeedVideo(page: Page): Promise<string> {
  await page.goto("/");
  const cards = page.locator('a[href^="/watch/"]');
  await expect(cards.first()).toBeVisible();
  await cards.first().click();
  await page.waitForURL(/\/watch\/[^/]+$/);
  return page.url();
}

/**
 * Open a specific long-form video.
 *
 * Selecting by duration rather than by position makes these tests independent
 * of whatever else is in the database — another spec uploads a two-second clip,
 * and a two-second clip cannot be seeked five seconds into or resumed at six.
 * `last` is used when a test needs a video no other test has watched, since the
 * others all start from the top of the feed.
 */
async function openPlayerVideo(page: Page, position: "first" | "last" = "first"): Promise<string> {
  const response = await page.request.get("/api/feed?tab=home&limit=24");
  expect(response.ok()).toBe(true);
  const feed = (await response.json()) as { items: { id: string; durationSec: number }[] };
  const longEnough = feed.items.filter((item) => item.durationSec >= 8);
  expect(longEnough.length).toBeGreaterThan(0);
  const target = position === "last" ? longEnough[longEnough.length - 1]! : longEnough[0]!;
  await page.goto(`/watch/${target.id}`);
  await page.waitForURL(/\/watch\/[^/]+$/);
  return page.url();
}

test.describe("video player", () => {
  test("replaces the native control bar and actually plays", async ({ page }) => {
    await openFeedVideo(page);

    const video = page.locator("video").first();
    await expect(video).toBeVisible();

    // The native chrome is gone: the custom layer is the only control surface.
    const initial = await mediaState(page);
    expect(initial.hasNativeControls).toBe(false);
    // A real, resolvable source — not a placeholder or a blob.
    expect(initial.src).toBeTruthy();
    expect(initial.src).toMatch(/^\/api\/media\//);

    const source = await page.request.get(initial.src!, { headers: { Range: "bytes=0-1023" } });
    expect(source.status()).toBe(206);
    expect(source.headers()["content-range"]).toContain("bytes 0-1023/");

    // The seek bar must be bounded by the real duration. The markup ships with
    // its source, so metadata can finish loading before hydration: this is the
    // regression guard for a player that would otherwise stay at "0:00".
    const seek = page.getByRole("slider", { name: "Seek" });
    await expect(seek).toBeVisible();
    await expect
      .poll(async () => Number(await seek.getAttribute("max")), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Play, and prove playback is genuinely advancing rather than just flipping
    // a boolean.
    await page.getByRole("button", { name: "Play" }).first().click();
    await expect
      .poll(async () => (await mediaState(page)).currentTime, { timeout: 20_000 })
      .toBeGreaterThan(0.4);
    expect((await mediaState(page)).paused).toBe(false);

    // Seeking through the control moves the playhead. Measured against the
    // real duration so the assertion holds whatever the fixture length is.
    const duration = (await mediaState(page)).duration;
    expect(duration).toBeGreaterThan(0);
    await seek.fill(String(duration / 2));
    await expect
      .poll(async () => (await mediaState(page)).currentTime)
      .toBeGreaterThan(duration / 4);

    // The shortcut reference is available and describes this player.
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByText(/Play or pause/i).first()).toBeVisible();
    await page.getByRole("button", { name: "Close keyboard shortcuts" }).click();
  });

  test("lists this video's real renditions and switching keeps the position", async ({ page }) => {
    const { labels } = await openWatchPageWithRenditions(page);

    // The menu is derived from stored assets: every entry is a resolution, and
    // there is no fabricated "Auto" or adaptive entry.
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) expect(label).toMatch(/^\d+p$/);
    expect(labels).not.toContain("Auto");

    const heights = labels.map((label) => Number(label.replace("p", "")));
    expect(heights).toEqual([...heights].sort((a, b) => b - a));

    // Play a little so a position exists to preserve.
    await page.getByRole("button", { name: "Play" }).first().click();
    await expect
      .poll(async () => (await mediaState(page)).currentTime, { timeout: 20_000 })
      .toBeGreaterThan(0.5);
    const before = await mediaState(page);

    // Switch to the smallest rendition, exactly as a viewer would.
    const target = labels[labels.length - 1];
    await page.getByRole("button", { name: SETTINGS }).click();
    await page.getByRole("menuitem", { name: /Quality/ }).click();
    await page.getByRole("menuitemradio", { name: target, exact: true }).click();

    await expect
      .poll(async () => (await mediaState(page)).src, { timeout: 20_000 })
      .toContain(`${target}.mp4`);

    const after = await mediaState(page);
    expect(after.src).not.toBe(before.src);
    // The stored file for the chosen quality exists and is range-capable.
    const rendition = await page.request.get(after.src!, { headers: { Range: "bytes=0-1023" } });
    expect(rendition.status()).toBe(206);
    expect(rendition.headers()["content-type"]).toContain("video/mp4");

    // Switching quality must not restart the video.
    await expect
      .poll(async () => (await mediaState(page)).currentTime)
      .toBeGreaterThan(before.currentTime - 1);

    // The chosen quality is reflected in the menu.
    await page.getByRole("button", { name: SETTINGS }).click();
    await expect(page.getByRole("menuitem", { name: new RegExp(`Quality ${target}`) })).toBeVisible();
    await page.getByRole("button", { name: SETTINGS }).click();
  });

  test("changes playback speed from the menu and the keyboard", async ({ page }) => {
    await openPlayerVideo(page);

    await page.getByRole("button", { name: SETTINGS }).click();
    await page.getByRole("menuitem", { name: /Speed/ }).click();
    await page.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();

    await expect.poll(async () => (await mediaState(page)).playbackRate).toBe(1.5);

    // Keyboard control. Choosing a speed closes the menu, so focus is back on
    // the document and the shortcut applies to the player.
    await page.keyboard.press(".");
    await expect.poll(async () => (await mediaState(page)).playbackRate).toBeGreaterThan(1.5);
    await page.keyboard.press(",");
    await expect.poll(async () => (await mediaState(page)).playbackRate).toBe(1.5);
  });

  test("keyboard shortcuts and mute work on the live element", async ({ page }) => {
    await openPlayerVideo(page);
    await expect
      .poll(async () => Number.isFinite((await mediaState(page)).duration), { timeout: 20_000 })
      .toBe(true);

    // k toggles playback.
    await page.keyboard.press("k");
    await expect.poll(async () => (await mediaState(page)).paused).toBe(false);
    await page.keyboard.press("k");
    await expect.poll(async () => (await mediaState(page)).paused).toBe(true);

    // ArrowRight seeks forward by five seconds.
    await page.locator("video").first().evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 0;
    });
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(4);

    // The mute button drives the element's own muted state.
    await page.getByRole("button", { name: "Mute" }).click();
    await expect
      .poll(async () =>
        page.locator("video").first().evaluate((element) => (element as HTMLVideoElement).muted),
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  });

  test("saves progress and offers to resume on return", async ({ page }) => {
    const url = await openPlayerVideo(page, "last");

    // Play past the resume threshold, then pause: pausing flushes the position
    // to the server rather than waiting for the periodic write.
    await page.getByRole("button", { name: "Play" }).first().click();
    await expect
      .poll(async () => (await mediaState(page)).currentTime, { timeout: 40_000 })
      .toBeGreaterThan(5.5);

    // Wait for the write itself rather than assuming it has landed: the flush
    // is a `keepalive` request that outlives the page.
    const saved = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.request().method() === "PUT",
    );
    await page.keyboard.press("k");
    expect((await saved).ok()).toBe(true);
    await expect.poll(async () => (await mediaState(page)).paused).toBe(true);

    // Returning to the video picks the position back up.
    await page.goto(url);
    await expect(page.getByText(/Resumed from/i)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(4);

    // "Start over" rewinds the element rather than just hiding the message.
    await page.getByRole("button", { name: "Start over" }).click();
    await expect.poll(async () => (await mediaState(page)).currentTime).toBeLessThan(1);
  });

  test("offers no quality menu for a video with a single rendition", async ({ page }) => {
    test.slow(); // transcoding runs with concurrency 1 in development

    const title = `E2E single-rendition ${Date.now()}`;

    await page.goto("/studio/upload");
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(process.cwd(), "storage", "test-media", "tiny-2s.mp4"));
    await page.locator("#upload-title").fill(title);
    await page.locator("#upload-visibility").selectOption("PUBLIC");
    await page.getByRole("button", { name: "Upload" }).click();
    await page.waitForURL(/\/watch\/[^/]+$/, { timeout: 150_000 });

    const uploaded = await mediaState(page);
    expect(uploaded.duration).toBeGreaterThan(0);

    // The 320x180 source is smaller than every rung of the ladder, so no
    // additional rendition is produced. The row reports that — and is not
    // interactive — instead of inventing a quality list, which is what "never
    // hard-coded" has to mean in practice.
    await page.getByRole("button", { name: SETTINGS }).click();
    const menu = page.getByRole("menu", { name: "Player settings" });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Quality");
    await expect(menu).toContainText("Single rendition");
    // No quality options at all, and nothing fabricated to fill the gap.
    await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  });
});
