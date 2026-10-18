/**
 * Avatar with a deterministic gradient fallback.
 *
 * Avatars are served through DEXTube's own media endpoint (never a raw
 * filesystem path), and fall back to the user's initials over an original
 * gradient derived from their id — no placeholder image asset needed.
 */
import { initialsOf, paletteFor } from "@/lib/format";

export interface AvatarProps {
  name: string;
  seed?: string;
  src?: string | null;
  size?: number;
  className?: string;
  /** Renders a square (channel) instead of a circle. */
  square?: boolean;
}

export function Avatar({ name, seed, src, size = 36, className = "", square = false }: AvatarProps) {
  const palette = paletteFor(seed ?? name);
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.round(size * 0.38)),
    borderRadius: square ? Math.round(size * 0.28) : 999,
    background: `linear-gradient(135deg, ${palette.from}, ${palette.to})`,
    color: "#fff",
    fontWeight: 700,
    flex: `0 0 ${size}px`,
  };

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={`object-cover ${className}`}
        style={{ ...style, background: "var(--dt-surface-2)" }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center select-none ${className}`}
      style={style}
    >
      {initialsOf(name)}
    </span>
  );
}
