import { expect, test as base, type BrowserContextOptions, type Page } from "@playwright/test";
import { register } from "./helpers";

/**
 * Player behaviour added on top of `player.spec.ts`: the buffered-range bar, the
 * elapsed/remaining time toggle, the honest empty state for captions, the
 * autoplay preference, and the guard that keeps shortcuts out of text fields.
 *
 * As in `player.spec.ts`, one registration is shared by the whole file (the
 * registration endpoint is rate-limited to five accounts per hour per IP), and
 * a video is chosen from `/api/feed` by duration so the assertions hold against
 * whatever catalogue is present.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const SETTINGS = "Settings";

const test = base.extend<object, { playerStorage: BrowserContextOptions["storageState"] }>({
  playerStorage: [
    async ({ browser }, provide) => {
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

/** Open a video long enough to seek and buffer. */
async function openPlayerVideo(page: Page): Promise<string> {
  const response = await page.request.get("/api/feed?tab=home&limit=24");
  expect(response.ok()).toBe(true);
  const feed = (await response.json()) as { items: { id: string; durationSec: number }[] };
  const longEnough = feed.items.filter((item) => item.durationSec >= 8);
  expect(longEnough.length).toBeGreaterThan(0);
  await page.goto(`/watch/${longEnough[0]!.id}`);
  await page.waitForURL(/\/watch\/[^/]+$/);
  return page.url();
}

/** Read the live media element's state. */
async function mediaState(page: Page) {
  return page.locator("video").first().evaluate((element) => {
    const video = element as HTMLVideoElement;
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      muted: video.muted,
    };
  });
}

/** Play until the element has loaded metadata and is advancing. */
async function startPlayback(page: Page): Promise<void> {
  const seek = page.getByRole("slider", { name: "Seek" });
  await expect.poll(async () => Number(await seek.getAttribute("max")), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Play" }).first().click();
  await expect
    .poll(async () => (await mediaState(page)).currentTime, { timeout: 20_000 })
    .toBeGreaterThan(0.4);
}

test.describe("player extras", () => {
  test("draws a real buffered bar inside the seek track", async ({ page }) => {
    await openPlayerVideo(page);
    await startPlayback(page);

    const seek = page.getByRole("slider", { name: "Seek" });
    const bufferedBar = page.getByTestId("buffered-bar");

    // The bar exists, lives inside the seek track, is decorative and cannot
    // intercept the drag.
    await expect(bufferedBar).toBeAttached();
    await expect(seek.locator("xpath=..").getByTestId("buffered-bar")).toHaveCount(1);
    await expect(bufferedBar).toHaveAttribute("aria-hidden", "true");
    expect(await bufferedBar.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    // After playback the browser reports at least one buffered range, and it is
    // painted with a non-zero width.
    await expect
      .poll(
        async () => {
          const ranges = page.getByTestId("buffered-range");
          if ((await ranges.count()) === 0) return 0;
          const box = await ranges.first().boundingBox();
          return box?.width ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  });

  test("toggles the time readout between elapsed and remaining and remembers it", async ({ page }) => {
    const url = await openPlayerVideo(page);
    await expect.poll(async () => (await mediaState(page)).duration, { timeout: 20_000 }).toBeGreaterThan(0);

    const timeToggle = page.getByTestId("time-toggle");
    await expect(timeToggle).toBeVisible();

    // Default is elapsed; the accessible name says what a click will do.
    await expect(timeToggle).not.toHaveText(/^-/);
    await expect(timeToggle).toHaveAttribute("aria-label", /Show remaining time/i);

    // Clicking switches to the remaining form, which starts with "-".
    await timeToggle.click();
    await expect(timeToggle).toHaveText(/^-/);
    await expect(timeToggle).toHaveAttribute("aria-label", /Show elapsed time/i);

    // And back.
    await timeToggle.click();
    await expect(timeToggle).not.toHaveText(/^-/);

    // The choice is persisted: switch to remaining, reload, still remaining.
    await timeToggle.click();
    await expect(timeToggle).toHaveText(/^-/);
    await page.goto(url);
    const afterReload = page.getByTestId("time-toggle");
    await expect(afterReload).toHaveText(/^-/, { timeout: 20_000 });

    // It is a real button, so it toggles from the keyboard too.
    await afterReload.focus();
    await page.keyboard.press("Enter");
    await expect(afterReload).not.toHaveText(/^-/);
  });

  test("offers no captions control when the video has no text tracks", async ({ page }) => {
    await openPlayerVideo(page);

    const trackCount = await page
      .locator("video")
      .first()
      .evaluate((element) => (element as HTMLVideoElement).textTracks.length);
    test.skip(trackCount > 0, "the fixture video carries caption tracks");

    // Nothing is invented: no bar button and no settings row.
    await expect(page.getByRole("button", { name: /captions|subtitles/i })).toHaveCount(0);

    await page.getByRole("button", { name: SETTINGS }).click();
    const menu = page.getByRole("menu", { name: "Player settings" });
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("Captions");
    await expect(menu.getByText("Captions", { exact: true })).toHaveCount(0);
  });

  test("still exposes the real quality options and speeds", async ({ page }) => {
    // Find a video with more than one stored rendition.
    let labels: string[] = [];
    const response = await page.request.get("/api/feed?tab=home&limit=8");
    expect(response.ok()).toBe(true);
    const feed = (await response.json()) as { items: { id: string }[] };

    for (const item of feed.items) {
      await page.goto(`/watch/${item.id}`);
      await page.getByRole("button", { name: SETTINGS }).click();
      const qualityRow = page.getByRole("menuitem", { name: /Quality/ });
      // A single-rendition video renders "Single rendition" text, not a menuitem.
      if (await qualityRow.count()) {
        await qualityRow.click();
        const options = page.getByRole("menuitemradio");
        const count = await options.count();
        if (count >= 2) {
          labels = (await options.allInnerTexts()).map((text) => text.trim());
          break;
        }
      }
      await page.getByRole("button", { name: SETTINGS }).click();
    }

    expect(labels.length, "no multi-rendition video found in the feed").toBeGreaterThanOrEqual(2);
    for (const label of labels) expect(label).toMatch(/^\d+p$/);
    expect(labels).not.toContain("Auto");
    const heights = labels.map((label) => Number(label.replace("p", "")));
    expect(heights).toEqual([...heights].sort((a, b) => b - a));

    // Back to the root, then open Speed.
    await page.getByRole("menuitem", { name: "Back" }).click();
    const qualityRootRow = page.getByRole("menuitem", { name: /Quality/ });
    await expect(qualityRootRow).not.toContainText("Auto");

    await page.getByRole("menuitem", { name: /Speed/ }).click();
    const speeds = (await page.getByRole("menuitemradio").allInnerTexts()).map((text) => text.trim());
    expect(speeds).toHaveLength(8);
    expect(speeds[0]).toBe("0.25×");
    expect(speeds.some((label) => label.startsWith("2×"))).toBe(true);
  });

  test("remembers the autoplay preference and never starts with sound", async ({ page }) => {
    const url = await openPlayerVideo(page);

    await page.getByRole("button", { name: SETTINGS }).click();
    const toggle = page.getByRole("menuitemcheckbox", { name: "Autoplay", exact: true });
    await expect(toggle).toBeVisible();
    // Default is off.
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    // The preference survives a reload…
    await page.goto(url);
    await page.getByRole("button", { name: SETTINGS }).click();
    const persisted = page.getByRole("menuitemcheckbox", { name: "Autoplay", exact: true });
    await expect(persisted).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    // …and is only ever honoured without sound: either playback did not start,
    // or it started muted. It must never be playing audibly on its own.
    await page.waitForTimeout(1_500);
    await expect
      .poll(
        async () =>
          page.locator("video").first().evaluate((element) => {
            const video = element as HTMLVideoElement;
            return video.paused || video.muted;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  test("does not hijack shortcuts typed into a text field", async ({ page }) => {
    await openPlayerVideo(page);

    const search = page.getByRole("combobox", { name: "Search DEXTube" });
    await search.click();
    await search.fill("hello");
    await page.locator("video").first().evaluate((element) => (element as HTMLVideoElement).pause());
    const before = await mediaState(page);
    expect(before.paused).toBe(true);

    // "k" would toggle play if the shortcut listener did not ignore inputs.
    await page.keyboard.press("k");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);

    expect(await search.inputValue()).toBe("hellok");
    const after = await mediaState(page);
    expect(after.paused).toBe(true);
    expect(after.currentTime).toBeCloseTo(before.currentTime, 1);
  });
});
