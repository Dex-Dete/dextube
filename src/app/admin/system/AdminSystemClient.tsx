"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { SpinnerIcon } from "@/components/icons";

const CONFIRM_WORD = "DISABLE";

/**
 * The one bootstrap control the application may offer: turning the switch OFF.
 *
 * There is deliberately no "enable" control — the API refuses it, so rendering
 * one would be a fake control. The confirmation word guards against a stray
 * click, and any error from the API is shown verbatim.
 */
export function AdminSystemClient({ dbEnabled }: { dbEnabled: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!dbEnabled) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <span className="dt-badge dt-badge-success">Disabled</span>
        <span className="text-muted">
          The bootstrap is switched off in the database. It cannot be re-enabled from here.
        </span>
      </p>
    );
  }

  async function submit() {
    if (busy || confirm.trim().toUpperCase() !== CONFIRM_WORD) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch("/api/admin/settings", { adminBootstrapEnabled: false });
      setDone(true);
      setConfirm("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disable the administrator bootstrap.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted">
        Disabling records an audit entry and stops DEXTube from creating an initial administrator. It never modifies
        or deletes an existing account. Type <strong>{CONFIRM_WORD}</strong> to confirm.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <label htmlFor="bootstrap-confirm" className="dt-label">
            Confirmation
          </label>
          <input
            id="bootstrap-confirm"
            className="dt-input w-full"
            value={confirm}
            autoComplete="off"
            placeholder={CONFIRM_WORD}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="dt-btn dt-btn-danger"
          disabled={busy || confirm.trim().toUpperCase() !== CONFIRM_WORD}
        >
          {busy ? <SpinnerIcon size={16} /> : null} Disable administrator bootstrap
        </button>
      </div>
      {done && <p className="text-sm text-success">The administrator bootstrap is now disabled.</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
