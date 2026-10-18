import type { NextConfig } from "next";

/**
 * DEXTube Next.js configuration.
 *
 * Security headers are applied globally. `frame-ancestors 'self'` plus the
 * X-Frame-Options header prevent clickjacking of the watch pages, and the
 * Content-Security-Policy is intentionally conservative while still allowing
 * locally served media through the same origin.
 */
const isProd = process.env.NODE_ENV === "production";

const csp = [
  "default-src 'self'",
  // Next.js requires inline bootstrap scripts. In dev it also needs eval.
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `@node-rs/argon2` and `@prisma/client` ship native/binary payloads; keep
  // them out of the bundler so they load via native require.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", "prisma"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
