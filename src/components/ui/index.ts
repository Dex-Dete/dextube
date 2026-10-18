/**
 * Shared presentation primitives.
 *
 * Import from here rather than reaching into individual files, so a future
 * rename or split does not ripple through page code.
 */
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { SectionCard, type SectionCardProps } from "./SectionCard";
export { StatCard, type StatCardProps } from "./StatCard";
export { PlaylistCard, playlistHref, type PlaylistCardData, type PlaylistCardProps } from "./PlaylistCard";
export {
  CardSkeleton,
  FeedSkeleton,
  PageHeaderSkeleton,
  StatsSkeleton,
  TableSkeleton,
  WatchSkeleton,
} from "./Skeletons";
