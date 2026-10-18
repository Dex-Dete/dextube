import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/shell/Shell";
import { ThemeScript } from "@/components/shell/ThemeScript";
import { getCurrentUser } from "@/server/auth/session";
import { getNavData } from "@/server/services/nav";
import { getConfig } from "@/lib/config";
import type { ViewerDTO } from "@/lib/dto";

/**
 * Inter is self-hosted by Next.js at build time (the browser never contacts
 * Google), which is what keeps the strict `font-src 'self' data:` CSP working.
 * The generated `--font-inter` variable is what `--font-sans` in globals.css
 * points at, so the named face is the one that actually renders.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

/**
 * Metadata is generated (not a static object) so `metadataBase` can be the
 * configured `APP_URL`. Without it Next.js guesses from the request and warns at
 * runtime; with it, relative Open Graph / icon URLs resolve to the real origin
 * behind a reverse proxy.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(getConfig().appUrl),
    title: {
      default: "DEXTube",
      template: "%s · DEXTube",
    },
    description:
      "DEXTube is an open-source, self-hostable video sharing platform. Upload, watch, comment, subscribe and go live with Shorts.",
    applicationName: "DEXTube",
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d13" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const nav = await getNavData(user?.id ?? null);

  const viewer: ViewerDTO | null = user
    ? {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarKey: user.avatarKey,
        emailVerified: user.emailVerified,
        hasChannel: Boolean(user.channel),
        channel: user.channel
          ? {
              id: user.channel.id,
              handle: user.channel.handle,
              name: user.channel.name,
              avatarKey: user.channel.avatarKey,
            }
          : null,
      }
    : null;

  const config = getConfig();

  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={inter.variable}>
      <head>
        <ThemeScript />
      </head>
      <body>
        <Suspense fallback={<div style={{ minHeight: "100vh" }} />}>
          <Shell
            viewer={viewer}
            subscriptions={nav.subscriptions}
            unreadNotifications={nav.unreadNotifications}
          >
            {children}
          </Shell>
        </Suspense>
        {config.isProd && null /* production-only additions go here */}
      </body>
    </html>
  );
}
