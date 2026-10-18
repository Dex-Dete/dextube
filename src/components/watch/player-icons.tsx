/**
 * Icons used only by the DEXTube player.
 *
 * Kept out of `@/components/icons` so the shared icon set stays the app's
 * general-purpose vocabulary; these are control-bar specifics.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Picture-in-picture: a frame with an inset frame. */
export const PipIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.5" y="4" width="19" height="15" rx="2.5" />
    <rect x="12" y="11" width="7.5" height="5.5" rx="1.2" />
  </Glyph>
);

/** Exit fullscreen: inward-pointing corners. */
export const FullscreenExitIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9 4v5H4" />
    <path d="M15 20v-5h5" />
    <path d="M4 15h5v5" />
    <path d="M20 9h-5V4" />
  </Glyph>
);

/** Quality / resolution selector. */
export const QualityIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M7 9.5v5M7 12h2.5M9.5 9.5v5" />
    <path d="M14 9.5v5h1.2a2.5 2.5 0 0 0 0-5H14z" />
  </Glyph>
);

/** Keyboard shortcuts help. */
export const KeyboardIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" />
  </Glyph>
);

/** Slideshow / autoplay-next toggle. */
export const AutoplayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 6.5h9M4 12h9M4 17.5h6" />
    <path d="M15.5 10.5l5 3.5-5 3.5z" />
  </Glyph>
);

/** Loop / replay. */
export const ReplayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4.5h-4.5" />
  </Glyph>
);
