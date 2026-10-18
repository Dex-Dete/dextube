import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_BASE, sessionCookiePolicy } from "@/lib/session-cookie";

describe("session cookie policy", () => {
  it("uses Secure and the __Host- prefix for an https origin", () => {
    const policy = sessionCookiePolicy("https://dextube.example.org");
    expect(policy.secure).toBe(true);
    expect(policy.name).toBe(`__Host-${SESSION_COOKIE_BASE}`);
    expect(policy.overridden).toBe(false);
  });

  it("omits Secure for a plain-HTTP origin so a LAN deployment can log in", () => {
    // Browsers silently discard a Secure cookie delivered over HTTP, which
    // would make login appear to succeed and then fail on the next request.
    const policy = sessionCookiePolicy("http://192.168.1.10:3000");
    expect(policy.secure).toBe(false);
    expect(policy.name).toBe(SESSION_COOKIE_BASE);
  });

  it("keeps localhost on HTTP usable without the prefix", () => {
    const policy = sessionCookiePolicy("http://localhost:3000");
    expect(policy.secure).toBe(false);
    expect(policy.name).toBe(SESSION_COOKIE_BASE);
  });

  it("is case-insensitive about the scheme and tolerates a trailing slash", () => {
    expect(sessionCookiePolicy("HTTPS://DEXTube.example/").secure).toBe(true);
  });

  it("honours an explicit override", () => {
    const forcedSecure = sessionCookiePolicy("http://192.168.1.10:3000", "true");
    expect(forcedSecure.secure).toBe(true);
    expect(forcedSecure.name).toBe(`__Host-${SESSION_COOKIE_BASE}`);
    expect(forcedSecure.overridden).toBe(true);

    const forcedPlain = sessionCookiePolicy("https://dextube.example.org", "false");
    expect(forcedPlain.secure).toBe(false);
    expect(forcedPlain.name).toBe(SESSION_COOKIE_BASE);
  });
});
