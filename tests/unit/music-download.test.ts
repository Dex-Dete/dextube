/**
 * Unit tests for DEX Music download authorisation.
 *
 * `evaluateDownloadAccess()` is the single pure decision point the media route
 * ultimately relies on, so it is tested directly and without a database: for
 * every combination of visibility, rights flag and viewer, streaming and
 * downloading are decided independently and a missing permission fails closed.
 */
import { describe, expect, it } from "vitest";
import { evaluateDownloadAccess, type MusicViewer } from "@/server/services/music";

const anonymous: MusicViewer = { channelId: null, role: "USER" };
const owner: MusicViewer = { channelId: "chan_owner", role: "USER" };
const stranger: MusicViewer = { channelId: "chan_other", role: "USER" };
const moderator: MusicViewer = { channelId: null, role: "MODERATOR" };

function decide(input: {
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
  downloadAllowed: boolean;
  viewer: MusicViewer;
}) {
  return evaluateDownloadAccess({
    visibility: input.visibility,
    trackChannelId: "chan_owner",
    downloadAllowed: input.downloadAllowed,
    viewer: input.viewer,
  });
}

describe("evaluateDownloadAccess", () => {
  it("allows a public track whose rights permit downloads, even signed out", () => {
    expect(decide({ visibility: "PUBLIC", downloadAllowed: true, viewer: anonymous })).toEqual({
      visible: true,
      allowed: true,
    });
  });

  it("keeps a public track streamable but refuses the copy when downloads are not permitted", () => {
    const decision = decide({ visibility: "PUBLIC", downloadAllowed: false, viewer: anonymous });
    expect(decision.visible).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it("treats an unlisted track like a public one for both permissions", () => {
    expect(decide({ visibility: "UNLISTED", downloadAllowed: true, viewer: anonymous })).toEqual({
      visible: true,
      allowed: true,
    });
    expect(decide({ visibility: "UNLISTED", downloadAllowed: false, viewer: anonymous }).allowed).toBe(false);
  });

  it("hides a private track from everyone but the owning channel and moderators", () => {
    expect(decide({ visibility: "PRIVATE", downloadAllowed: true, viewer: anonymous })).toEqual({
      visible: false,
      allowed: false,
    });
    expect(decide({ visibility: "PRIVATE", downloadAllowed: true, viewer: stranger })).toEqual({
      visible: false,
      allowed: false,
    });
    // A stranger must not learn that the track exists merely because its
    // download flag is set.
    expect(decide({ visibility: "PRIVATE", downloadAllowed: false, viewer: stranger }).visible).toBe(false);
  });

  it("lets the owning channel stream and download a private track it is allowed to download", () => {
    expect(decide({ visibility: "PRIVATE", downloadAllowed: true, viewer: owner })).toEqual({
      visible: true,
      allowed: true,
    });
  });

  it("lets a moderator stream a private track but still respects a download ban", () => {
    expect(decide({ visibility: "PRIVATE", downloadAllowed: true, viewer: moderator })).toEqual({
      visible: true,
      allowed: true,
    });
    const denied = decide({ visibility: "PRIVATE", downloadAllowed: false, viewer: moderator });
    expect(denied.visible).toBe(true);
    expect(denied.allowed).toBe(false);
  });

  it("fails closed: an absent download permission is never 'allowed'", () => {
    // The service passes `rights?.downloadAllowed ?? false`; `false` is the only
    // value that ever reaches here when the rights row is missing.
    expect(decide({ visibility: "PUBLIC", downloadAllowed: false, viewer: owner }).allowed).toBe(false);
  });
});
