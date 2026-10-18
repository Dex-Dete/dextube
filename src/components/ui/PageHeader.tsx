import type { ReactNode } from "react";
import clsx from "clsx";

export interface PageHeaderProps {
  /** Small label above the title — a breadcrumb, section name, or "Studio". */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or controls aligned to the trailing edge on wide screens. */
  actions?: ReactNode;
  /** Optional content rendered under the header (tabs, filters). */
  children?: ReactNode;
  className?: string;
}

/**
 * The one page-title block.
 *
 * Establishes the app's heading hierarchy in a single place: eyebrow (uppercase,
 * tracked, subtle), `h1` at `text-xl` — deliberately not an oversized display
 * heading — an optional description, and trailing actions that wrap under the
 * title on narrow screens instead of squeezing.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={clsx("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-xl font-bold leading-snug">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
