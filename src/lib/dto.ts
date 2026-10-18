/**
 * Serializable DTOs handed from server components to client components.
 * Keeping these explicit stops accidental leakage of password hashes, emails,
 * session tokens or internal storage keys into the client bundle.
 */

export interface ChannelSummaryDTO {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
}

export interface ViewerDTO {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  emailVerified: boolean;
  /** True when the account has a channel and may therefore upload. */
  hasChannel: boolean;
  channel: ChannelSummaryDTO | null;
}

export interface VideoCardDTO {
  id: string;
  title: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  publishedAt: string | null;
  viewCount: number;
  likeCount?: number;
  channel: ChannelSummaryDTO;
  /** Present for the viewer's own drafts inside Studio. */
  visibility?: "PRIVATE" | "UNLISTED" | "PUBLIC";
  status?: string;
}

export interface PlaylistSummaryDTO {
  id: string;
  title: string;
  itemCount: number;
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  isSystem: boolean;
  systemKind: string | null;
  thumbnailKey: string | null;
}

/**
 * Rights metadata for a track, shaped for display. `downloadAllowed` is the
 * single flag the UI may use to decide whether a download control is rendered
 * at all — and the server re-checks it before serving a `?download=1` request.
 */
export interface TrackRightsDTO {
  source: string;
  license: string;
  attribution: string;
  territory: string;
  downloadAllowed: boolean;
}

/** A track as shown in the library and handed to the mini-player queue. */
export interface TrackDTO {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  /** Opaque storage key; the client builds `/api/media/<key>` from it. */
  audioKey: string;
  channel: ChannelSummaryDTO;
  rights: TrackRightsDTO | null;
}

export interface CommentDTO {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  likeCount: number;
  replyCount: number;
  isPinned: boolean;
  viewerHasLiked: boolean;
  canModerate: boolean;
  isMine: boolean;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarKey: string | null;
    channelHandle: string | null;
  };
  replies?: CommentDTO[];
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string;
  isRead: boolean;
  createdAt: string;
  actorAvatarKey: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
