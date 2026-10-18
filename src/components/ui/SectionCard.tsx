import type { ReactNode } from "react";
import clsx from "clsx";

export interface SectionCardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls aligned to the trailing edge of the header row. */
  actions?: ReactNode;
  children: ReactNode;
  /** Drop the inner padding when the body is a full-bleed table or list. */
  flush?: boolean;
  className?: string;
}

/**
 * A titled content section.
 *
 * Studio, settings and analytics previously repeated "breadcrumb + stacked
 * card sections" as raw markup on every page. This keeps the header geometry,
 * divider and padding consistent so those pages differ by *content*, not by
 * whether someone remembered the same classes.
 */
export function SectionCard({
  title,
  description,
  actions,
  children,
  flush = false,
  className,
}: SectionCardProps) {
  const hasHeader = Boolean(title || description || actions);
  return (
    <section className={clsx("dt-card overflow-hidden", className)}>
      {hasHeader ? (
        <div
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3"
          style={{ borderColor: "var(--dt-line)" }}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-bold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-subtle">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
