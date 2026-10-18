import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Primary/secondary actions, rendered as a wrapped row. */
  actions?: ReactNode;
  /** Decorative icon or illustration shown above the title. */
  icon?: ReactNode;
  /**
   * `boxed` draws a card with a dashed border (default, used for page-level
   * emptiness). `inline` is borderless and suited to nested sections.
   */
  variant?: "boxed" | "inline";
  className?: string;
}

/**
 * The single empty-state presentation for the whole app.
 *
 * Before this existed the same card markup was copy-pasted on thirteen pages,
 * which is why every screen looked like a template. Centralising it keeps the
 * copy, spacing and action placement identical everywhere and makes the
 * deliberate variation (icon vs. none, boxed vs. inline) a prop instead of a
 * copy-paste decision.
 */
export function EmptyState({
  title,
  description,
  actions,
  icon,
  variant = "boxed",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center gap-3 px-6 text-center",
        variant === "boxed" && "rounded-xl border border-dashed py-14",
        variant === "inline" && "py-10",
        className,
      )}
      style={variant === "boxed" ? { borderColor: "var(--dt-line-strong)" } : undefined}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded-full"
          style={{ background: "var(--dt-surface-2)", color: "var(--dt-fg-subtle)" }}
        >
          {icon}
        </span>
      ) : null}
      <p className="text-base font-semibold">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {actions ? <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
