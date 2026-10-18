import { PageHeaderSkeleton, TableSkeleton } from "@/components/ui";

/**
 * Loading fallback for the DEX Music surface (library and track pages).
 * Mirrors the shared page frame so the shell does not jump while the segment
 * streams in, and the table silhouette matches the library rows.
 */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-6" />
      <TableSkeleton rows={6} label="Loading music" />
    </div>
  );
}
