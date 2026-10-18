import Link from "next/link";
import { DexLogo, DexWordmark } from "@/components/icons";

/**
 * Centred card layout for the authentication screens.
 * It deliberately keeps the global header/sidebar shell so a visitor can still
 * search and browse while signed out.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-var(--dt-header-h))] items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <DexLogo size={36} />
            <span className="text-2xl">
              <DexWordmark />
            </span>
          </Link>
        </div>
        <div className="dt-card p-6 shadow-dt-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-subtle">
          DEXTube is free and open source (AGPL-3.0).{" "}
          <Link href="/about" className="dt-link">
            Learn more
          </Link>
        </p>
      </div>
    </div>
  );
}
