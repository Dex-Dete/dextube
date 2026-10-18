/**
 * Unit tests for the import fetcher's SSRF policy.
 *
 * These are the checks that stop an administrator-supplied URL from being turned
 * into a request against the host's own network. They are pure functions, so they
 * are exercised here directly rather than through a live socket.
 */
import { describe, expect, it } from "vitest";
import { hostAllowed, isBlockedAddress } from "@/server/import/safe-fetch";

describe("hostAllowed", () => {
  const allow = [".youtube.com", "www.googleapis.com"];

  it("matches an exact host for a bare entry", () => {
    expect(hostAllowed("www.googleapis.com", allow)).toBe(true);
    expect(hostAllowed("googleapis.com", allow)).toBe(false);
  });

  it("matches the apex and every subdomain for a dotted entry", () => {
    expect(hostAllowed("youtube.com", allow)).toBe(true);
    expect(hostAllowed("www.youtube.com", allow)).toBe(true);
    expect(hostAllowed("m.youtube.com", allow)).toBe(true);
  });

  it("does not match a suffix that is not on a label boundary", () => {
    expect(hostAllowed("evilyoutube.com", allow)).toBe(false);
    expect(hostAllowed("youtube.com.evil.test", allow)).toBe(false);
  });

  it("ignores case and a trailing dot", () => {
    expect(hostAllowed("WWW.YouTube.COM", allow)).toBe(true);
    expect(hostAllowed("www.youtube.com.", allow)).toBe(true);
  });

  it("permits nothing when the allowlist is empty", () => {
    expect(hostAllowed("youtube.com", [])).toBe(false);
  });
});

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and CGNAT IPv4", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks documentation, benchmarking and multicast IPv4 ranges", () => {
    for (const address of ["192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "142.250.72.14", "172.15.0.1", "172.32.0.1", "192.167.1.1"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("blocks loopback, link-local, unique-local and multicast IPv6", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "64:ff9b::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 that hides a private address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1 in hex
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows ordinary public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("2a00:1450:4001:80e::200e")).toBe(false);
  });

  it("blocks anything that is not an IP address at all", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("localhost")).toBe(true);
  });
});
