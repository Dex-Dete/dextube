"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { mediaUrl } from "@/lib/media-url";
import type { ChannelSummaryDTO, ViewerDTO } from "@/lib/dto";
import {
  HistoryIcon,
  HomeIcon,
  LikedIcon,
  MusicIcon,
  PlaylistIcon,
  SettingsIcon,
  ShortsIcon,
  StudioIcon,
  SubscriptionsIcon,
  UsersIcon,
  WatchLaterIcon,
} from "@/components/icons";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
}

const EXPLORE: NavItem[] = [
  { href: "/", label: "Home", icon: <HomeIcon />, exact: true },
  { href: "/shorts", label: "Shorts", icon: <ShortsIcon /> },
  { href: "/music", label: "Music", icon: <MusicIcon /> },
  { href: "/feed/subscriptions", label: "Subscriptions", icon: <SubscriptionsIcon /> },
];

const YOU: NavItem[] = [
  { href: "/history", label: "History", icon: <HistoryIcon /> },
  { href: "/playlists", label: "Playlists", icon: <PlaylistIcon /> },
  { href: "/playlist/watch-later", label: "Watch later", icon: <WatchLaterIcon /> },
  { href: "/playlist/liked", label: "Liked videos", icon: <LikedIcon /> },
];

export interface SidebarProps {
  viewer: ViewerDTO | null;
  subscriptions: ChannelSummaryDTO[];
  expanded: boolean;
  /** Mobile drawer mode: always full width, closes on navigation. */
  drawer: boolean;
  onNavigate?: () => void;
}

export function Sidebar({ viewer, subscriptions, expanded, drawer, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const rail = !drawer && !expanded;

  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col gap-1 overflow-y-auto overscroll-contain pb-24 pt-3"
      style={{ height: "100%" }}
    >
      <NavSection items={EXPLORE} rail={rail} pathname={pathname} onNavigate={onNavigate} />

      {viewer && (
        <>
          <Separator rail={rail} />
          <SectionTitle label="You" rail={rail} />
          {viewer.hasChannel && <NavSection items={[{ href: "/studio", label: "DEXTube Studio", icon: <StudioIcon /> }]} rail={rail} pathname={pathname} onNavigate={onNavigate} />}
          <NavSection items={YOU} rail={rail} pathname={pathname} onNavigate={onNavigate} />
        </>
      )}

      <Separator rail={rail} />
      <SectionTitle label="Subscriptions" rail={rail} />
      {subscriptions.length === 0 ? (
        <p className={`px-4 text-xs text-subtle ${rail ? "hidden" : ""}`}>
          {viewer ? "Channels you subscribe to appear here." : (
            <>
              <Link href="/login" className="dt-link" onClick={onNavigate}>Sign in</Link> to see your subscriptions.
            </>
          )}
        </p>
      ) : (
        <ul className={`flex flex-col gap-0.5 ${rail ? "hidden" : ""}`}>
          {subscriptions.map((channel) => {
            const href = `/channel/${channel.handle}`;
            const active = pathname === href;
            return (
              <li key={channel.id}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-surface-2"
                  style={active ? { background: "var(--dt-surface-2)", fontWeight: 600 } : undefined}
                >
                  <Avatar name={channel.name} seed={channel.id} src={mediaUrl(channel.avatarKey)} size={26} />
                  <span className="truncate">{channel.name}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <Link href="/feed/subscriptions" onClick={onNavigate} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-surface-2">
              <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full bg-surface-2">
                <UsersIcon size={16} />
              </span>
              <span>All subscriptions</span>
            </Link>
          </li>
        </ul>
      )}

      <Separator rail={rail} />
      <NavSection
        items={[{ href: viewer ? "/settings" : "/login", label: viewer ? "Settings" : "Sign in", icon: <SettingsIcon /> }]}
        rail={rail}
        pathname={pathname}
        onNavigate={onNavigate}
      />
    </nav>
  );
}

function NavSection({
  items,
  rail,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  rail: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              title={rail ? item.label : undefined}
              className={`flex items-center rounded-lg text-sm transition-colors hover:bg-surface-2 ${
                rail ? "flex-col gap-1 px-1 py-2 text-[10px]" : "gap-4 px-3 py-2.5"
              }`}
              style={active ? { background: "var(--dt-surface-2)", fontWeight: 600 } : undefined}
            >
              <span aria-hidden="true" className="shrink-0">
                {item.icon}
              </span>
              <span className={rail ? "truncate" : ""}>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SectionTitle({ label, rail }: { label: string; rail: boolean }) {
  if (rail) return null;
  return (
    <h2 className="px-5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-subtle">{label}</h2>
  );
}

function Separator({ rail }: { rail: boolean }) {
  return <div className="my-1 mx-4 border-t border-line" style={{ marginLeft: rail ? 8 : 16, marginRight: rail ? 8 : 16 }} />;
}
