/**
 * Original DEXTube icon set.
 *
 * Hand-drawn 24×24 SVG paths using a 1.7px rounded stroke — deliberately
 * different geometry from other platforms' icon fonts. No icon library is
 * used, so there is no third-party asset licensing to track.
 *
 * The DEXTube mark itself (the "DEX cube") is original artwork defined here.
 */
import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...rest }: IconProps) {
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

/* ------------------------------------------------------------------ brand */

/** The DEXTube mark: an original rounded cube with a play cut-out. */
export function DexLogo({ size = 28, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" {...rest}>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#dtg)" />
      <path d="M13 10.6v10.8l9-5.4-9-5.4Z" fill="#fff" />
      <defs>
        <linearGradient id="dtg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7C5CFF" />
          <stop offset="1" stopColor="#FF5C7A" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const DexWordmark = ({ className }: { className?: string }) => (
  <span className={className} style={{ letterSpacing: "-0.02em" }}>
    <span style={{ fontWeight: 800 }}>DEX</span>
    <span style={{ fontWeight: 500, color: "var(--dt-fg-muted)" }}>Tube</span>
  </span>
);

/* ---------------------------------------------------------------- navigation */

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6 10v9.5h12V10" />
  </Icon>
);

export const ShortsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="3" width="8" height="18" rx="4" />
    <path d="M11 9.5v5l4-2.5-4-2.5Z" />
  </Icon>
);

export const SubscriptionsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="M3 10h18" />
    <path d="M10 13.5v3l4-1.5-4-1.5Z" />
  </Icon>
);

export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 4v4.5H8" />
    <path d="M12 8v4.5l3 1.8" />
  </Icon>
);

export const PlaylistIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h11M4 11h11M4 16h7" />
    <path d="M17 13v7l5-3.5-5-3.5Z" />
  </Icon>
);

export const WatchLaterIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const LikedIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 10.5V20H4.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7Z" />
    <path d="M7 10.5 11 3.8a2 2 0 0 1 3.6 1.5l-.9 4.2h4.5a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7" />
  </Icon>
);

export const StudioIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M3 9h18" />
    <path d="M9 13h6M9 16.5h4" />
  </Icon>
);

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const UploadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 16V5" />
    <path d="m8 9 4-4 4 4" />
    <path d="M4.5 15.5v2.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7v-2.8" />
  </Icon>
);

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 10.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z" />
    <path d="M10.2 19a2 2 0 0 0 3.6 0" />
  </Icon>
);

export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20a7.4 7.4 0 0 1 14.4 0" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
  </Icon>
);

export const SignOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 5.5H6.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2H14" />
    <path d="M12.5 12h8" />
    <path d="m17.5 8.8 3.2 3.2-3.2 3.2" />
  </Icon>
);

/* ---------------------------------------------------------------- actions */

export const LikeIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M7 10.5V20H4.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7Z" />
    <path d="M7 10.5 11 3.8a2 2 0 0 1 3.6 1.5l-.9 4.2h4.5a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7" />
  </Icon>
);

export const DislikeIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M17 13.5V4h2.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H17Z" />
    <path d="M17 13.5 13 20.2a2 2 0 0 1-3.6-1.5l.9-4.2H5.8a2 2 0 0 1-2-2.4l1.3-6a2 2 0 0 1 2-1.6H17" />
  </Icon>
);

export const ShareIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 6.5 20 12l-7 5.5V14c-5 0-7.5 2-9 5 0-6 3-9 9-9V6.5Z" />
  </Icon>
);

export const SaveIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5V20l-7-4-7 4V6.5Z" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11" />
    <path d="m8 11 4 4 4-4" />
    <path d="M4.5 17.5v.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7v-.8" />
  </Icon>
);

export const CommentIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </Icon>
);

export const EditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z" />
    <path d="m14.5 7.5 2 2" />
  </Icon>
);

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.8 12S6 6.5 12 6.5 21.2 12 21.2 12 18 17.5 12 17.5 2.8 12 2.8 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);

export const EyeOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l16 16" />
    <path d="M9.5 9.7A2.8 2.8 0 0 0 12 14.8c.7 0 1.4-.3 1.9-.7" />
    <path d="M6.3 6.8C4 8.4 2.8 12 2.8 12s3.2 5.5 9.2 5.5c1.5 0 2.8-.3 3.9-.9" />
    <path d="M10.2 6.7A9.8 9.8 0 0 1 12 6.5c6 0 9.2 5.5 9.2 5.5a17 17 0 0 1-2.6 3.2" />
  </Icon>
);

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </Icon>
);

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
  </Icon>
);

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.2}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" strokeWidth={0}>
    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" strokeWidth={0}>
    <rect x="7" y="5.5" width="3.6" height="13" rx="1.2" />
    <rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" />
  </Icon>
);

export const VolumeIcon = ({ level = 1, ...p }: IconProps & { level?: number }) => (
  <Icon {...p}>
    <path d="M4 9.5h3L11 5.5v13L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none" />
    {level > 0.05 && <path d="M14.5 9.5a4 4 0 0 1 0 5" />}
    {level > 0.55 && <path d="M17 7a7 7 0 0 1 0 10" />}
    {level <= 0.05 && <path d="m15 9.5 4 5M19 9.5l-4 5" />}
  </Icon>
);

export const FullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
    <path d="M20 9V5.5A1.5 1.5 0 0 0 18.5 4H15" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20H9" />
    <path d="M20 15v3.5A1.5 1.5 0 0 1 18.5 20H15" />
  </Icon>
);

export const CaptionsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="3" />
    <path d="M10 10.5a2.5 2.5 0 1 0 0 3" />
    <path d="M17 10.5a2.5 2.5 0 1 0 0 3" />
  </Icon>
);

export const SpeedIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 13l3.5-3.5" />
  </Icon>
);

export const SparkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5 10.2 12.6 4.5 10.8 10.2 9 12 3.5Z" />
  </Icon>
);

export const UsersIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
    <path d="M16 5.4a3.5 3.5 0 0 1 0 6.6" />
    <path d="M17.6 20a6.4 6.4 0 0 0-1.3-3.9" />
  </Icon>
);

export const ReportIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 20V4.5h11l-2 4 2 4H6" />
  </Icon>
);

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4h6l-.8 5.2 3 3.3H6.8l3-3.3L9 4Z" />
    <path d="M12 12.5V20" />
  </Icon>
);

export const SpinnerIcon = (p: IconProps) => (
  <Icon {...p} className={`dt-spin ${p.className ?? ""}`}>
    <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5V9H15" />
  </Icon>
);
