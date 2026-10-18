import type { ReactNode } from "react";
import clsx from "clsx";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Secondary line under the value (comparison, qualifier, timestamp). */
  hint?: ReactNode;
  /**
   * Change versus the previous period. Signed; the sign drives the arrow and
   * colour. Pass `null`/`undefined` when there is no comparison period, which
   * renders nothing rather than a misleading "+0%".
   */
  delta?: number | null;
  /** How the delta is expressed. `percent` appends a % sign. */
  deltaUnit?: "percent" | "absolute";
  /** Renders the value in a muted, smaller style — for "--" style placeholders. */
  muted?: boolean;
  className?: string;
}

/**
 * A single KPI.
 *
 * Deltas are only rendered when a real comparison exists, and always carry a
 * screen-reader phrase ("up 12 percent") so the direction is not conveyed by
 * colour alone.
 */
export function StatCard({
  label,
  value,
  hint,
  delta = null,
  deltaUnit = "percent",
  muted = false,
  className,
}: StatCardProps) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const positive = hasDelta && delta > 0;
  const negative = hasDelta && delta < 0;
  const deltaText = hasDelta
    ? `${delta > 0 ? "+" : ""}${formatDelta(delta, deltaUnit)}`
    : null;

  return (
    <div className={clsx("dt-card p-4", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">{label}</p>
      <p
        className={clsx(
          "mt-1.5 font-bold tabular-nums",
          muted ? "text-base text-subtle" : "text-2xl",
        )}
      >
        {value}
      </p>
      <div className="mt-1 flex items-center gap-1.5 text-xs">
        {hasDelta ? (
          <>
            <span
              aria-hidden="true"
              className={clsx(
                "font-semibold",
                positive && "text-success",
                negative && "text-danger",
                !positive && !negative && "text-subtle",
              )}
            >
              {positive ? "▲" : negative ? "▼" : "—"} {deltaText}
            </span>
            <span className="sr-only">
              {positive ? "up" : negative ? "down" : "unchanged"} {deltaText} versus the previous period
            </span>
          </>
        ) : null}
        {hint ? <span className="text-subtle">{hint}</span> : null}
      </div>
    </div>
  );
}

function formatDelta(delta: number, unit: "percent" | "absolute"): string {
  const rounded = Math.abs(delta) >= 100 ? Math.round(delta) : Math.round(delta * 10) / 10;
  return unit === "percent" ? `${rounded}%` : String(rounded);
}
