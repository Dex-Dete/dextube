"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { Sidebar } from "@/components/shell/Sidebar";
import type { ChannelSummaryDTO, ViewerDTO } from "@/lib/dto";

const STORAGE_KEY = "dextube-sidebar-expanded";

export interface ShellProps {
  viewer: ViewerDTO | null;
  subscriptions: ChannelSummaryDTO[];
  unreadNotifications: number;
  children: React.ReactNode;
}

/**
 * Client shell that owns the two pieces of layout state the server cannot
 * know: whether the sidebar is expanded and whether the mobile drawer is open.
 *
 * Layout contract
 *  * The header is fixed (56px) so feeds can scroll under it.
 *  * The sidebar is fixed below the header on desktop, and a modal drawer on
 *    mobile. Its width is exposed as a CSS variable so page content can align.
 */
export function Shell({ viewer, subscriptions, unreadNotifications, children }: ShellProps) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Restore the saved preference after mount to keep SSR output stable: the
  // server has no access to `localStorage`, so reading it during render would
  // produce a hydration mismatch. This is the one shape the `set-state-in-effect`
  // rule must be told about explicitly.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mount read
      if (saved === "false") setExpanded(false);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  // Close the mobile drawer whenever the route changes. Reset during render
  // (React's recommended pattern) rather than in an effect, so the drawer does
  // not flash open for one frame on the new route.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // Escape closes the drawer, and the page behind it must not scroll.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  const sidebarWidth = expanded ? "var(--dt-sidebar-w)" : "var(--dt-sidebar-w-rail)";

  return (
    <div className="min-h-screen">
      <a href="#main-content" className="dt-skip-link">
        Skip to content
      </a>

      <Header
        viewer={viewer}
        unreadNotifications={unreadNotifications}
        sidebarExpanded={expanded}
        onToggleSidebar={toggleExpanded}
        onOpenSidebar={() => setDrawerOpen(true)}
      />

      {/* Desktop sidebar */}
      <aside
        className="fixed bottom-0 left-0 z-30 hidden border-r border-line bg-surface lg:block"
        style={{ top: "var(--dt-header-h)", width: sidebarWidth, transition: "width 0.18s var(--dt-ease)" }}
        aria-label="Sidebar"
      >
        <Sidebar viewer={viewer} subscriptions={subscriptions} expanded={expanded} drawer={false} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 border-none"
            style={{ background: "var(--dt-overlay)" }}
          />
          <div
            className="absolute bottom-0 left-0 top-0 w-[270px] max-w-[85vw] border-r border-line bg-surface shadow-dt-lg"
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
          >
            <Sidebar
              viewer={viewer}
              subscriptions={subscriptions}
              expanded
              drawer
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      <div
        className="pt-[var(--dt-header-h)]"
        style={{ ["--dt-sidebar-current" as string]: expanded ? "var(--dt-sidebar-w)" : "var(--dt-sidebar-w-rail)" }}
      >
        <div className="lg:pl-[var(--dt-sidebar-current)]">
          {/* `tabIndex={-1}` makes the skip link actually move focus here rather
              than only scrolling; the outline is suppressed because focusing a
              whole landmark would draw a ring around the page. */}
          <main
            id="main-content"
            tabIndex={-1}
            className="min-h-[calc(100vh-var(--dt-header-h))] focus:outline-none"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
