import type { ReactNode } from "react";
import Link from "next/link";
import { mediaUrl } from "@/lib/media-url";

export interface PlaylistCardData {
  id: string;
  title: string;
  coverKey: string | null;
  itemCount: number;
  isSystem: boolean;
  systemKind: string | null;
}

export interface PlaylistCardProps {
  playlist: PlaylistCardData;
  /** Overrides the noun in the item-count badge (e.g. "track" for DEX Music). */
  itemNoun?: string;
  /**
   * Overrides the default "Playlist" / "Built-in playlist" caption. Search
   * results use it to keep the owner channel name the old bespoke card showed.
   */
  subtitle?: ReactNode;
}

/** Route for a playlist, including the special-cased system playlists. */
export function playlistHref(playlist: Pick<PlaylistCardData, "id" | "systemKind">): string {
  if (playlist.systemKind === "watch_later") return "/playlist/watch-later";
  if (playlist.systemKind === "liked_videos") return "/playlist/liked";
  return `/playlist/${playlist.id}`;
}

/**
 * Playlist tile.
 *
 * This markup was duplicated verbatim in the playlists, search-results and
 * channel pages. `systemKind` decides the destination, so that rule lives here
 * too rather than being re-implemented per page.
 */
export function PlaylistCard({ playlist, itemNoun = "video", subtitle }: PlaylistCardProps) {
  return (
    <li className="dt-card-hover overflow-hidden rounded-xl">
      <Link href={playlistHref(playlist)} className="block">
        <div className="dt-aspect-video relative" style={{ background: "var(--dt-surface-2)" }}>
          {playlist.coverKey ? (
            <img
              src={mediaUrl(playlist.coverKey)!}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : null}
          <span
            className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
          >
            {playlist.itemCount} {playlist.itemCount === 1 ? itemNoun : `${itemNoun}s`}
          </span>
        </div>
        <div className="p-3">
          <p className="truncate font-semibold">{playlist.title}</p>
          <p className="truncate text-xs text-subtle">
            {subtitle ?? (playlist.isSystem ? "Built-in playlist" : "Playlist")}
          </p>
        </div>
      </Link>
    </li>
  );
}
