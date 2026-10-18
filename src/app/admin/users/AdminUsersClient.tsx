"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { SpinnerIcon } from "@/components/icons";

/** Shape of one row, mirroring the service's `AdminUserSummary` (no hash). */
interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  isSuspended: boolean;
  suspendedReason: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  channelHandle: string | null;
}

export function AdminUsersClient({
  users: initial,
  currentUserId,
}: {
  users: AdminUser[];
  currentUserId: string | null;
}) {
  const [users, setUsers] = useState<AdminUser[]>(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpenId(null);
    setConfirm("");
    setReason("");
    setError(null);
  }

  async function disable(user: AdminUser) {
    if (confirm !== user.username) {
      setError("Type the account's username exactly to confirm.");
      return;
    }
    setBusyId(user.id);
    setError(null);
    try {
      const result = await api.post<{ user: AdminUser }>(`/api/admin/users/${user.id}/disable`, {
        confirm,
        reason: reason.trim() ? reason.trim() : undefined,
      });
      setUsers((current) => current.map((row) => (row.id === result.user.id ? result.user : row)));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disable that account.");
    } finally {
      setBusyId(null);
    }
  }

  async function enable(user: AdminUser) {
    setBusyId(user.id);
    setError(null);
    try {
      const result = await api.post<{ user: AdminUser }>(`/api/admin/users/${user.id}/enable`);
      setUsers((current) => current.map((row) => (row.id === result.user.id ? result.user : row)));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enable that account.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="border-b px-4 py-2 text-sm text-danger" style={{ borderColor: "var(--dt-line)" }}>
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="dt-visually-hidden">Accounts on this instance</caption>
          <thead>
            <tr className="text-xs text-subtle">
              <th scope="col" className="px-4 py-2 font-semibold">Account</th>
              <th scope="col" className="px-4 py-2 font-semibold">Role</th>
              <th scope="col" className="px-4 py-2 font-semibold">Status</th>
              <th scope="col" className="px-4 py-2 font-semibold">Created</th>
              <th scope="col" className="px-4 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <tr key={user.id} className="border-t align-top" style={{ borderColor: "var(--dt-line)" }}>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{user.displayName}</p>
                    <p className="text-xs text-muted">@{user.username}</p>
                    <p className="text-xs text-subtle">{user.email}</p>
                    {user.channelHandle && <p className="text-xs text-subtle">channel @{user.channelHandle}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`dt-badge ${user.role === "ADMIN" ? "dt-badge-brand" : ""}`}>{user.role}</span>
                  </td>
                  <td className="px-4 py-3">
                    {user.isSuspended ? (
                      <div>
                        <span className="dt-badge dt-badge-danger">Suspended</span>
                        {user.suspendedReason && (
                          <p className="mt-1 max-w-[220px] text-xs text-subtle">{user.suspendedReason}</p>
                        )}
                      </div>
                    ) : (
                      <span className="dt-badge dt-badge-success">Active</span>
                    )}
                    {user.mustChangePassword && (
                      <p className="mt-1">
                        <span className="dt-badge dt-badge-warning">Password change required</span>
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDateTime(user.createdAt)}</td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <span className="text-xs text-subtle">Your account</span>
                    ) : user.isSuspended ? (
                      <button
                        type="button"
                        className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                        disabled={busyId === user.id}
                        onClick={() => void enable(user)}
                      >
                        {busyId === user.id ? <SpinnerIcon size={14} /> : null} Enable
                      </button>
                    ) : openId === user.id ? (
                      <div className="flex min-w-[220px] flex-col gap-2">
                        <input
                          className="dt-input"
                          value={confirm}
                          autoComplete="off"
                          placeholder={`Type ${user.username}`}
                          aria-label={`Type ${user.username} to confirm`}
                          onChange={(event) => setConfirm(event.target.value)}
                        />
                        <input
                          className="dt-input"
                          value={reason}
                          autoComplete="off"
                          placeholder="Reason (optional)"
                          aria-label="Reason"
                          onChange={(event) => setReason(event.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="dt-btn dt-btn-danger !px-3 !py-1 text-[13px]"
                            disabled={busyId === user.id || confirm !== user.username}
                            onClick={() => void disable(user)}
                          >
                            {busyId === user.id ? <SpinnerIcon size={14} /> : null} Confirm disable
                          </button>
                          <button
                            type="button"
                            className="dt-btn dt-btn-ghost !px-3 !py-1 text-[13px]"
                            onClick={reset}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="dt-btn dt-btn-danger !px-3 !py-1 text-[13px]"
                        onClick={() => {
                          reset();
                          setOpenId(user.id);
                        }}
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr className="border-t" style={{ borderColor: "var(--dt-line)" }}>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted">
                  No accounts found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
