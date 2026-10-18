/**
 * Presentation formatters shared by server and client components.
 * Pure functions only — safe to import from anywhere.
 */

const UNITS: Array<[number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
];

/** 1234 -> "1.2K", 45 -> "45" */
export function formatCount(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  for (const [size, suffix] of UNITS) {
    if (abs >= size) {
      const scaled = n / size;
      const digits = Math.abs(scaled) < 10 ? 1 : 0;
      return `${stripTrailingZero(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.trunc(n));
}

function stripTrailingZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Pluralised label: `countLabel(1,'view','views')` -> "1 view" */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/** Seconds -> "1:02:03" / "4:05" */
export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds ?? 0)));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Watch time in seconds -> "3.2 hours watched" style short form. */
export function formatWatchTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/** "3 days ago", "just now" */
export function formatRelativeTime(input: Date | string | number, now = Date.now()): string {
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  // (upper bound for this unit, unit name, seconds per unit)
  const units: Array<[number, string, number]> = [
    [60, "second", 1],
    [3600, "minute", 60],
    [86400, "hour", 3600],
    [604800, "day", 86400],
    [2592000, "week", 604800],
    [31536000, "month", 2592000],
    [Number.POSITIVE_INFINITY, "year", 31536000],
  ];
  for (const [limit, unit, divisor] of units) {
    if (seconds < limit) {
      const value = Math.floor(seconds / divisor);
      return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "";
}

/** Absolute date, e.g. "17 Oct 2026". */
export function formatDate(input: Date | string | number, locale = "en-GB"): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** "17 Oct 2026, 14:05" */
export function formatDateTime(input: Date | string | number, locale = "en-GB"): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** ISO day (YYYY-MM-DD) used for analytics buckets. */
export function isoDay(input: Date | string | number): string {
  const d = new Date(input);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatBytes(bytes: number | bigint | null | undefined): string {
  const n = typeof bytes === "bigint" ? Number(bytes) : Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Compact percentage, e.g. 0.734 -> "73.4%" */
export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Truncates on a word boundary with an ellipsis. */
export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Deterministic gradient for avatar/banner fallbacks (original artwork). */
export function paletteFor(seed: string): { from: string; to: string } {
  const palettes = [
    { from: "#7C5CFF", to: "#FF5C7A" },
    { from: "#2DD4BF", to: "#3B82F6" },
    { from: "#F59E0B", to: "#EF4444" },
    { from: "#8B5CF6", to: "#06B6D4" },
    { from: "#EC4899", to: "#F97316" },
    { from: "#22C55E", to: "#0EA5E9" },
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return palettes[hash % palettes.length]!;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
