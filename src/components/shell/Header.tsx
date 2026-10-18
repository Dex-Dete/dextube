"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { mediaUrl } from "@/lib/media-url";
import type { ViewerDTO } from "@/lib/dto";
import {
  BellIcon,
  CloseIcon,
  DexLogo,
  DexWordmark,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SignOutIcon,
  StudioIcon,
  SunIcon,
  UploadIcon,
  UserIcon,
} from "@/components/icons";

export interface HeaderProps {
  viewer: ViewerDTO | null;
  unreadNotifications: number;
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  onOpenSidebar: () => void;
}

export function Header({ viewer, unreadNotifications, sidebarExpanded, onToggleSidebar, onOpenSidebar }: HeaderProps) {
  const router = useRouter();

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) onOpenSidebar();
    else onToggleSidebar();
  }, [onOpenSidebar, onToggleSidebar]);

  return (
    <header
      className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3 sm:px-4"
      style={{ height: "var(--dt-header-h)" }}
    >
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarExpanded ? "Collapse navigation" : "Expand navigation"}
        aria-expanded={sidebarExpanded}
        className="dt-icon-btn shrink-0"
      >
        <MenuGlyph />
      </button>

      <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="DEXTube home">
        <DexLogo size={30} />
        <span className="hidden text-[19px] sm:inline">
          <DexWordmark />
        </span>
      </Link>

      <div className="mx-auto w-full max-w-2xl">
        <SearchBar />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle />
        {viewer ? (
          <>
            <Link
              href="/studio/upload"
              className="dt-btn dt-btn-secondary hidden !px-3 sm:inline-flex"
              title="Create — upload a video"
            >
              <UploadIcon size={20} />
              <span className="hidden md:inline">Create</span>
            </Link>
            <NotificationsMenu unread={unreadNotifications} />
            <AccountMenu viewer={viewer} onSignOut={() => router.push("/")} />
          </>
        ) : (
          <>
            <Link href="/login" className="dt-btn dt-btn-outline !px-4">
              Sign in
            </Link>
            <Link href="/register" className="dt-btn dt-btn-primary hidden !px-4 sm:inline-flex">
              Create account
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

function MenuGlyph() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/* ---------------------------------------------------------------- search */

interface Suggestion {
  kind: "video" | "channel" | "query";
  label: string;
  sublabel?: string;
  href: string;
}

/** Stable empty list so `activeSuggestions` keeps a constant identity. */
const NO_SUGGESTIONS: Suggestion[] = [];

function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the box in sync with `?q=` after a navigation. Reading
  // `window.location` avoids `useSearchParams()`, which would otherwise force
  // every page under the root layout into a Suspense boundary. Adjusting the
  // state during render (rather than in an effect) means the input already
  // holds the query on the first paint of the new route.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setValue(new URLSearchParams(window.location.search).get("q") ?? "");
  }

  // Below two characters there is nothing worth suggesting. Deriving this
  // instead of clearing state keeps the effect free of synchronous updates.
  const activeSuggestions = value.trim().length < 2 ? NO_SUGGESTIONS : suggestions;

  // Debounced suggestion fetch — cancelled on every keystroke.
  useEffect(() => {
    const query = value.trim();
    if (query.length < 2) return;
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions: Suggestion[] };
        setSuggestions(data.suggestions ?? []);
      } catch {
        /* aborted or offline — suggestions are non-critical */
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Pressing "/" anywhere focuses search (unless already typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = (query: string) => {
    const trimmed = query.trim();
    setOpen(false);
    inputRef.current?.blur();
    if (!trimmed) return;
    router.push(`/results?q=${encodeURIComponent(trimmed)}`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, activeSuggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key === "Enter" && activeIndex >= 0 && activeSuggestions[activeIndex]) {
      event.preventDefault();
      const picked = activeSuggestions[activeIndex];
      setOpen(false);
      if (picked.kind === "query") submit(picked.label);
      else router.push(picked.href);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <form
        role="search"
        action="/results"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          submit(value);
        }}
        className="flex items-center"
      >
        <label htmlFor="dextube-search" className="dt-visually-hidden">
          Search DEXTube
        </label>
        <div className="relative flex w-full items-center">
          <SearchIcon size={18} className="pointer-events-none absolute left-3 text-subtle" />
          <input
            ref={inputRef}
            id="dextube-search"
            name="q"
            type="search"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setOpen(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search videos, channels, tags…  (press /)"
            autoComplete="off"
            enterKeyHint="search"
            className="dt-input !w-full !rounded-full !pl-10 !pr-10"
            style={{ height: 40 }}
            role="combobox"
            aria-autocomplete="list"
            aria-controls="dextube-suggestions"
            aria-expanded={open && activeSuggestions.length > 0}
          />
          {value && (
            <button
              type="button"
              onClick={() => {
                setValue("");
                setSuggestions([]);
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-2 inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-2"
            >
              <CloseIcon size={16} />
            </button>
          )}
        </div>
      </form>

      {open && activeSuggestions.length > 0 && (
        <ul
          id="dextube-suggestions"
          role="listbox"
          className="dt-menu absolute left-0 right-0 top-[46px] z-50 max-h-[70vh] overflow-y-auto"
        >
          {activeSuggestions.map((suggestion, index) => (
            <li key={`${suggestion.kind}-${suggestion.href}-${index}`} role="option" aria-selected={index === activeIndex}>
              <Link
                href={suggestion.kind === "query" ? `/results?q=${encodeURIComponent(suggestion.label)}` : suggestion.href}
                onClick={() => setOpen(false)}
                className="dt-menu-item"
                style={index === activeIndex ? { background: "var(--dt-surface-2)" } : undefined}
              >
                <SearchIcon size={16} className="text-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{suggestion.label}</span>
                  {suggestion.sublabel && (
                    <span className="block truncate text-xs text-subtle">{suggestion.sublabel}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- theme */

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // `ThemeScript` applies the stored theme before first paint, so the DOM
  // already knows the answer — but the server does not, and reading it during
  // render would desynchronise hydration. Syncing once on mount is therefore
  // deliberate.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mount read
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("dextube-theme", next);
    } catch {
      /* storage disabled — theme still applies for this session */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="dt-icon-btn"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
    >
      {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
    </button>
  );
}

/* ------------------------------------------------------- notifications */

interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  url: string;
  isRead: boolean;
  createdAt: string;
  actorAvatarKey: string | null;
}

function NotificationsMenu({ unread }: { unread: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allRead, setAllRead] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derived, not synced: the server's count is the truth until the viewer
  // marks everything read in this session.
  const count = allRead ? 0 : unread;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/notifications?limit=8")
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load notifications.");
        return (await res.json()) as { items: NotificationRow[] };
      })
      .then((data) => {
        if (!cancelled) setRows(data.items);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const markAllRead = async () => {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    setRows((current) => current?.map((r) => ({ ...r, isRead: true })) ?? null);
    setAllRead(true);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
        className="dt-icon-btn relative"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
        title="Notifications"
      >
        <BellIcon size={20} />
        {count > 0 && (
          <span
            className="absolute right-0.5 top-0.5 inline-flex min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-bold"
            style={{ background: "var(--dt-accent)", color: "#fff" }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="dt-menu absolute right-0 top-[46px] z-50 !w-[340px]"
          style={{ maxWidth: "calc(100vw - 24px)" }}
        >
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button type="button" onClick={markAllRead} className="text-xs dt-link">
              Mark all read
            </button>
          </div>
          <div className="dt-menu-sep" />
          {error && <p className="px-3 py-4 text-xs text-danger">{error}</p>}
          {!error && rows === null && <p className="px-3 py-4 text-xs text-subtle">Loading…</p>}
          {!error && rows?.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-subtle">
              No notifications yet. Subscribe to a channel to hear about new uploads.
            </p>
          )}
          {rows?.map((row) => (
            <Link
              key={row.id}
              href={row.url}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="dt-menu-item items-start"
            >
              <Avatar name="DEXTube" seed={row.actorAvatarKey ?? row.id} src={mediaUrl(row.actorAvatarKey)} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{row.title}</span>
                {row.body && <span className="mt-0.5 block truncate text-xs text-muted">{row.body}</span>}
              </span>
              {!row.isRead && (
                <span
                  aria-label="Unread"
                  className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: "var(--dt-brand)" }}
                />
              )}
            </Link>
          ))}
          <div className="dt-menu-sep" />
          <Link href="/notifications" role="menuitem" onClick={() => setOpen(false)} className="dt-menu-item justify-center">
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- account menu */

function AccountMenu({ viewer, onSignOut }: { viewer: ViewerDTO; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setOpen(false);
      onSignOut();
      // Deliberate full navigation: a hard load guarantees no cached RSC
      // payload from the signed-in session survives in the client router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard reload after the session changes
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full p-0.5 hover:bg-surface-2"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar name={viewer.displayName} seed={viewer.id} src={mediaUrl(viewer.avatarKey)} size={32} />
      </button>

      {open && (
        <div role="menu" className="dt-menu absolute right-0 top-[46px] z-50">
          <div className="flex items-center gap-3 px-3 py-3">
            <Avatar name={viewer.displayName} seed={viewer.id} src={mediaUrl(viewer.avatarKey)} size={40} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{viewer.displayName}</p>
              <p className="truncate text-xs text-subtle">@{viewer.username}</p>
            </div>
          </div>
          <div className="dt-menu-sep" />
          {viewer.channel && (
            <Link href={`/channel/${viewer.channel.handle}`} role="menuitem" onClick={() => setOpen(false)} className="dt-menu-item">
              <UserIcon size={18} /> Your channel
            </Link>
          )}
          <Link href="/studio" role="menuitem" onClick={() => setOpen(false)} className="dt-menu-item">
            <StudioIcon size={18} /> DEXTube Studio
          </Link>
          <Link href="/settings" role="menuitem" onClick={() => setOpen(false)} className="dt-menu-item">
            <SettingsIcon size={18} /> Settings
          </Link>
          {!viewer.channel && (
            <Link href="/studio" role="menuitem" onClick={() => setOpen(false)} className="dt-menu-item">
              <UploadIcon size={18} /> Create a channel
            </Link>
          )}
          <div className="dt-menu-sep" />
          <button type="button" role="menuitem" onClick={signOut} disabled={busy} className="dt-menu-item">
            <SignOutIcon size={18} /> {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
