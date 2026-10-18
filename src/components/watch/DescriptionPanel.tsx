"use client";

import Link from "next/link";
import { useState } from "react";
import { formatCount, formatDate, formatDuration } from "@/lib/format";
import { ChevronDownIcon, GlobeIcon, LockIcon } from "@/components/icons";

export interface DescriptionPanelProps {
  description: string;
  viewCount: number;
  publishedAt: string | null;
  createdAt: string;
  durationSec: number;
  tags: string[];
  category: string | null;
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  isOwner: boolean;
  status: string;
  processingError: string | null;
}

/**
 * Video description.
 *
 * Collapsed by default (as users expect) with a real expand/collapse control.
 * When the video belongs to the viewer and is not playable, the reason is shown
 * here rather than as a silent failure.
 */
export function DescriptionPanel({
  description,
  viewCount,
  publishedAt,
  durationSec,
  tags,
  category,
  visibility,
  isOwner,
  status,
  processingError,
}: DescriptionPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const long = description.length > 240 || description.includes("\n");

  return (
    <div
      className="rounded-xl p-3 text-sm"
      style={{ background: "var(--dt-surface-2)" }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold">
        <span>{formatCount(viewCount)} views</span>
        <span>{publishedAt ? formatDate(publishedAt) : "Not published"}</span>
        {durationSec > 0 && <span className="text-subtle">{formatDuration(durationSec)}</span>}
        {visibility !== "PUBLIC" && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]" style={{ background: "var(--dt-surface)" }}>
            {visibility === "PRIVATE" ? <LockIcon size={11} /> : <GlobeIcon size={11} />}
            {visibility === "PRIVATE" ? "Private" : "Unlisted"}
          </span>
        )}
        {category && <span className="text-subtle">· {category}</span>}
      </div>

      {isOwner && status !== "READY" && (
        <p role="status" className="mt-2 rounded-md px-2.5 py-2 text-[13px] text-danger" style={{ background: "var(--dt-surface)" }}>
          {status === "PROCESSING"
            ? "This video is still being processed. It is not visible to anyone else yet."
            : status === "FAILED"
              ? `Processing failed: ${processingError ?? "unknown error"}`
              : `Status: ${status}`}
        </p>
      )}

      <div className={expanded ? "" : "line-clamp-3"}>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
          {description.trim() || "No description provided."}
        </p>
        {expanded && tags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <li key={tag}>
                <Link
                  href={`/results?q=${encodeURIComponent(`#${tag}`)}`}
                  className="rounded-full px-2.5 py-1 text-[12px] font-medium"
                  style={{ background: "var(--dt-surface)" }}
                >
                  #{tag}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(long || tags.length > 0) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold"
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDownIcon size={14} className={expanded ? "rotate-180" : ""} />
        </button>
      )}
    </div>
  );
}
