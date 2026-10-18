import path from "node:path";
import { expect, test } from "@playwright/test";
import { register } from "./helpers";

/**
 * The full creator path: register → upload → server processing → watch page →
 * comment. Processing is asynchronous, so the test waits for the uploader to
 * redirect to `/watch/:id` (which only happens once the video is READY).
 */
test.describe("upload → watch → comment", () => {
  test("uploads a video, plays it and posts a comment", async ({ page }) => {
    test.slow(); // transcoding runs with concurrency 1 in development

    const account = await register(page);
    const title = `E2E upload ${Date.now()}`;

    await page.goto("/studio/upload");
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(process.cwd(), "storage", "test-media", "tiny-2s.mp4"));
    await page.locator("#upload-title").fill(title);
    await page.locator("#upload-visibility").selectOption("PUBLIC");
    await page.getByRole("button", { name: "Upload" }).click();

    // The uploader polls processing and then routes to the watch page.
    await page.waitForURL(/\/watch\/[^/]+$/, { timeout: 150_000 });
    const videoId = new URL(page.url()).pathname.split("/").pop()!;

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

    // The player got a real, range-capable source.
    const src = await page.locator("video").first().getAttribute("src");
    expect(src).toBeTruthy();
    const range = await page.request.get(src!, { headers: { Range: "bytes=0-1023" } });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toContain("bytes 0-1023/");

    // Anonymous visitors can reach a public video.
    const anonymous = await page.context().browser()!.newContext();
    const anonPage = await anonymous.newPage();
    const anonResponse = await anonPage.goto(`/watch/${videoId}`);
    expect(anonResponse?.status()).toBe(200);
    await expect(anonPage.getByRole("heading", { level: 1 })).toHaveText(title);
    await anonymous.close();

    // Post a comment as the owner. The comment list updates optimistically, so
    // confirm through the comments API that the INSERT landed before reloading:
    // a reload fired mid-request would legitimately render the pre-comment page.
    const commentText = `Nice work ${Date.now()}`;
    await page.getByLabel("Write a comment").fill(commentText);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByText(commentText)).toBeVisible();
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/videos/${videoId}/comments`);
          if (!res.ok()) return -1;
          const data = (await res.json()) as { items?: { body?: string }[] };
          return (data.items ?? []).filter((c) => c.body === commentText).length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // It is persisted: reloading still shows it.
    await page.reload();
    await expect(page.getByText(commentText)).toBeVisible();

    // And the creator sees it in Studio.
    await page.goto("/studio/videos");
    await expect(page.getByText(title).first()).toBeVisible();

    // The home feed is reachable and renders.
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();

    void account;
  });
});
