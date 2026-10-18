"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export interface RecommendationResetProps {
  /** How many dismissals and hidden channels are currently stored. */
  total: number;
}

/**
 * Clears every stored recommendation preference.
 *
 * Deliberately separate from clearing watch history: a viewer who wants a fresh
 * feed should not lose the record of what they watched. The control only
 * appears when there is something to clear, so it is never a dead button, and it
 * asks for confirmation because it cannot be undone from the UI.
 */
export function RecommendationReset({ total }: RecommendationResetProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/feed/feedback", { action: "reset" });
      setConfirming(false);
      // Re-render the server component so the feed reflects the cleared state.
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset your recommendations.");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button type="button" onClick={() => setConfirming(true)} className="dt-btn dt-btn-ghost text-[13px]">
          Reset recommendations
          <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted">
            {total}
          </span>
        </button>
        {error ? (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="dt-card flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]"
      role="group"
      aria-label="Confirm resetting recommendations"
    >
      <span className="text-muted">
        Clear {total} hidden {total === 1 ? "item" : "items"}? Your watch history is not affected.
      </span>
      <button
        type="button"
        onClick={() => void reset()}
        disabled={busy || isPending}
        className="dt-btn dt-btn-danger !py-1 text-[12px]"
      >
        {busy || isPending ? "Resetting…" : "Reset"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="dt-btn dt-btn-ghost !py-1 text-[12px]"
      >
        Cancel
      </button>
      {error ? (
        <p role="alert" className="w-full text-[11px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
