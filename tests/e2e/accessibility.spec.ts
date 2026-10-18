import { expect, test as base, type BrowserContextOptions, type Page } from "@playwright/test";
import { register } from "./helpers";

/**
 * Accessibility and responsive layout.
 *
 * These are real measurements taken from the live DOM — accessible names,
 * heading levels, horizontal overflow and computed animation durations — rather
 * than a verdict from a tool. That keeps the suite dependency-free and, more
 * usefully, makes a failure name the exact page and viewport that broke.
 *
 * Every page in the list is checked at a phone width and a desktop width, because
 * two of the bugs this test was written to catch only existed at 375px: the
 * licence badge in the music list forced horizontal scrolling, and Tailwind's
 * `hidden` utility was being overridden by an unlayered component class, so
 * desktop-only header buttons stayed visible on a phone.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** One registration for the whole file, shared by every test. */
const test = base.extend<object, { accountStorage: BrowserContextOptions["storageState"] }>({
  accountStorage: [
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
  storageState: async ({ accountStorage }, provide) => {
    await provide(accountStorage);
  },
});

const VIEWPORTS = [
  { name: "phone (375px)", viewport: { width: 375, height: 812 } },
  { name: "desktop (1280px)", viewport: { width: 1280, height: 900 } },
];

interface Audit {
  page: string;
  unlabelled: string[];
  imagesWithoutAlt: string[];
  h1Count: number;
  overflowPx: number;
  lang: string;
  headingLevels: number[];
}

/** Everything asserted below, read once from the rendered page. */
async function audit(page: Page, label: string): Promise<Audit> {
  return page.evaluate((pageLabel) => {
    const accessibleName = (el: Element): string =>
      (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").trim();

    // `offsetParent` is null for `position: fixed` elements, so visibility is
    // decided from the box and the computed style instead.
    const isRendered = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return false;
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (getComputedStyle(node).display === "none") return false;
      }
      return true;
    };

    const describe = (el: Element): string =>
      `${el.tagName.toLowerCase()}[href=${el.getAttribute("href") ?? "-"}] class="${String(
        el.className,
      ).slice(0, 40)}"`;

    const controls = [...document.querySelectorAll("a,button")].filter(
      (el) => el.getAttribute("aria-hidden") !== "true" && isRendered(el),
    );

    const unlabelled = controls
      .filter((el) => {
        if (accessibleName(el)) return false;
        const image = el.querySelector("img[alt]");
        return !image || !(image.getAttribute("alt") ?? "").trim();
      })
      .map(describe);

    const imagesWithoutAlt = [...document.querySelectorAll("img")]
      .filter((img) => !img.hasAttribute("alt"))
      .map(describe);

    const headingLevels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(isRendered)
      .map((heading) => Number(heading.tagName.slice(1)));

    return {
      page: pageLabel,
      unlabelled,
      imagesWithoutAlt,
      h1Count: document.querySelectorAll("h1").length,
      overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lang: document.documentElement.getAttribute("lang") ?? "",
      headingLevels,
    };
  }, label);
}

/** The longest transition or animation currently applied to any element, in seconds. */
async function longestAnimationSeconds(page: Page): Promise<number> {
  return page.evaluate(() => {
    const longest = (value: string): number =>
      value
        .split(",")
        .map((part) => parseFloat(part) || 0)
        .reduce((max, current) => Math.max(max, current), 0);

    let max = 0;
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      max = Math.max(max, longest(style.transitionDuration), longest(style.animationDuration));
    }
    return max;
  });
}

async function firstPublicVideoId(page: Page): Promise<string> {
  const response = await page.request.get("/api/feed?tab=home&limit=4");
  expect(response.ok()).toBe(true);
  const feed = (await response.json()) as { items: { id: string }[] };
  expect(feed.items.length).toBeGreaterThan(0);
  return feed.items[0]!.id;
}

test.describe("accessibility and responsive layout", () => {
  test("every key page is labelled, single-h1 and free of horizontal overflow", async ({ page }) => {
    const videoId = await firstPublicVideoId(page);
    const paths: [string, string][] = [
      ["/", "home"],
      ["/trending", "trending"],
      ["/music", "music"],
      [`/watch/${videoId}`, "watch"],
      ["/results?q=algorithm", "search results"],
      ["/studio/videos", "studio content"],
    ];

    for (const { name, viewport } of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const [path, label] of paths) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        // Give client components (the player, the music library) a moment to
        // render their final markup before auditing it.
        await page.waitForTimeout(400);
        const result = await audit(page, `${label} at ${name}`);

        expect(result.unlabelled, `${result.page}: controls without an accessible name`).toEqual([]);
        expect(result.imagesWithoutAlt, `${result.page}: images without an alt attribute`).toEqual([]);
        expect(result.overflowPx, `${result.page}: horizontal overflow in pixels`).toBeLessThanOrEqual(1);
        expect(result.h1Count, `${result.page}: exactly one h1`).toBe(1);
        expect(result.lang, `${result.page}: document language`).toBeTruthy();
      }
    }
  });

  test("heading levels never skip a level", async ({ page }) => {
    const videoId = await firstPublicVideoId(page);
    for (const path of ["/", "/trending", "/music", `/watch/${videoId}`, "/results?q=algorithm"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(300);
      const { headingLevels, page: label } = await audit(page, path);

      let previous = 1; // an `h1` is present on every page and is checked above
      for (const level of headingLevels) {
        expect(level, `${label}: heading jumped from h${previous} to h${level}`).toBeLessThanOrEqual(
          previous + 1,
        );
        previous = level;
      }
    }
  });

  test("the skip link moves keyboard focus into the main landmark", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Let hydration finish: if the tree is replaced mid-tab, focus is dropped
    // and the first Tab would be swallowed.
    await page.waitForTimeout(500);

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await expect(skipLink).toBeFocused();

    await page.keyboard.press("Enter");
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.id ?? ""))
      .toBe("main-content");

    // And the next Tab continues from inside the content, not from the top.
    await page.keyboard.press("Tab");
    const stillInContent = await page.evaluate(() => {
      const main = document.getElementById("main-content");
      return Boolean(main && document.activeElement && main.contains(document.activeElement));
    });
    expect(stillInContent).toBe(true);
  });

  test("reduced motion removes animation", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);

    const normal = await longestAnimationSeconds(page);
    expect(normal, "the page should animate something by default").toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () => longestAnimationSeconds(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(0.01);
  });

  test("the navigation is reachable by keyboard at a phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The desktop sidebar is not rendered at this width.
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();

    await page.getByRole("button", { name: /navigation$/ }).click();
    const drawer = page.getByRole("dialog", { name: "Main navigation" });
    await expect(drawer).toBeVisible();

    // Following a link from the drawer navigates and closes it. (Clicking the
    // backdrop is not used: the drawer sits on top of it, so the click would be
    // intercepted — which is exactly why the link is the realistic path.)
    await drawer.getByRole("link", { name: "Music" }).click();
    await expect(page).toHaveURL(/\/music$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "DEX Music" })).toBeVisible();
  });
});
