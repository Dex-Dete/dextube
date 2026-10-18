import { expect, test } from "@playwright/test";

/**
 * DEX Music.
 *
 * The two things worth proving in a browser are that audio genuinely plays from
 * the stored file, and that a licence which does not permit downloading results
 * in no download control at all — not a disabled one. Both are checked against
 * the running production build.
 *
 * The mini-player is deliberately not tested with `page.goto`: a full page load
 * would remount it. Persistence across navigation means *client-side*
 * navigation, so the test clicks an in-app link.
 */

interface TrackDto {
  id: string;
  title: string;
  rights: { license: string; downloadAllowed: boolean };
}

async function publicTracks(page: import("@playwright/test").Page): Promise<TrackDto[]> {
  const response = await page.request.get("/api/music/tracks");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: TrackDto[] };
  expect(body.items.length).toBeGreaterThan(0);
  return body.items;
}

test.describe("DEX Music", () => {
  test("plays a track and keeps playing while the viewer navigates", async ({ page }) => {
    const tracks = await publicTracks(page);
    const playable = tracks.find((track) => track.rights.downloadAllowed) ?? tracks[0]!;

    await page.goto("/music");

    // The library shows real tracks with their licence, and no fabricated rows.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(playable.title).first()).toBeVisible();
    await expect(page.getByText(playable.rights.license).first()).toBeVisible();

    // Play from the card. This is also the user gesture the browser requires.
    await page.getByRole("button", { name: new RegExp(`^Play ${escapeRegExp(playable.title)}`) }).click();

    const mini = page.getByRole("region", { name: "Music mini-player" });
    await expect(mini).toBeVisible();

    const audio = page.locator("audio");
    await expect(audio).toHaveCount(1);

    // Real playback: the element's own clock advances.
    await expect
      .poll(async () => audio.evaluate((element) => (element as HTMLAudioElement).currentTime), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0.3);
    expect(await audio.evaluate((element) => (element as HTMLAudioElement).paused)).toBe(false);

    const before = await audio.evaluate((element) => (element as HTMLAudioElement).currentTime);

    // Client-side navigation must not tear the player down.
    await page.getByRole("link", { name: /^Home$/ }).first().click();
    await page.waitForURL((url) => url.pathname === "/");

    await expect(page.getByRole("region", { name: "Music mini-player" })).toBeVisible();
    await expect
      .poll(async () => page.locator("audio").evaluate((element) => (element as HTMLAudioElement).currentTime), {
        timeout: 20_000,
      })
      .toBeGreaterThan(before);
    expect(await page.locator("audio").evaluate((element) => (element as HTMLAudioElement).paused)).toBe(false);

    // The viewer can always stop it.
    await page.getByRole("button", { name: "Close player" }).click();
    await expect(page.getByRole("region", { name: "Music mini-player" })).toHaveCount(0);
  });

  test("a streaming-only licence offers no download at all", async ({ page }) => {
    const tracks = await publicTracks(page);
    const restricted = tracks.find((track) => !track.rights.downloadAllowed);
    test.skip(!restricted, "No streaming-only track is seeded; nothing to assert.");
    expect(restricted).toBeTruthy();

    await page.goto(`/music/${restricted!.id}`);

    // The reason is stated in words…
    await expect(page.getByText(/Not permitted/).first()).toBeVisible();
    await expect(page.getByText(restricted!.rights.license).first()).toBeVisible();
    // …and no download control exists.
    await expect(page.getByRole("link", { name: /download/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);

    // Streaming itself is still permitted.
    await page.getByRole("button", { name: new RegExp(`^Play ${escapeRegExp(restricted!.title)}`) }).click();
    await expect(page.getByRole("region", { name: "Music mini-player" })).toBeVisible();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
