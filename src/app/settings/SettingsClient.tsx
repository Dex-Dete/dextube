"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiClientError, api } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { SpinnerIcon } from "@/components/icons";

/** Reads per-field validation errors out of the API envelope. */
function fieldError(error: unknown, field: string): string | undefined {
  if (error instanceof ApiClientError && error.details) return error.details[field]?.[0];
  return undefined;
}
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/* ------------------------------------------------------------------ profile */

export function ProfileForm({
  initialDisplayName,
  initialUsername,
  initialBio,
}: {
  initialDisplayName: string;
  initialUsername: string;
  initialBio: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [username, setUsername] = useState(initialUsername);
  const [bio, setBio] = useState(initialBio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/account", { displayName, username, bio });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(fieldError(e, "username") ?? fieldError(e, "displayName") ?? messageOf(e, "Could not save your profile."));
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="displayName" className="dt-label">
            Display name
          </label>
          <input
            id="displayName"
            className="dt-input w-full"
            value={displayName}
            maxLength={60}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="username" className="dt-label">
            Username
          </label>
          <input
            id="username"
            className="dt-input w-full"
            value={username}
            maxLength={30}
            onChange={(event) => setUsername(event.target.value)}
          />
          <p className="mt-1 text-xs text-subtle">3–30 characters; letters, numbers, dashes or underscores.</p>
        </div>
      </div>
      <div>
        <label htmlFor="bio" className="dt-label">
          Bio
        </label>
        <textarea
          id="bio"
          rows={3}
          className="dt-input w-full"
          value={bio}
          maxLength={1000}
          onChange={(event) => setBio(event.target.value)}
          placeholder="Tell people a little about yourself (optional)."
        />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="dt-btn dt-btn-primary" disabled={busy}>
          {busy ? <SpinnerIcon size={16} /> : null} Save profile
        </button>
        {saved && <span className="text-sm text-success">Saved.</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/* -------------------------------------------------------------- preferences */

export function PreferencesForm({
  initialSaveWatchHistory,
  initialShowLikesPublicly,
}: {
  initialSaveWatchHistory: boolean;
  initialShowLikesPublicly: boolean;
}) {
  const router = useRouter();
  const [saveWatchHistory, setSaveWatchHistory] = useState(initialSaveWatchHistory);
  const [showLikesPublicly, setShowLikesPublicly] = useState(initialShowLikesPublicly);
  const [notifyOnNewVideo, setNotifyOnNewVideo] = useState(true);
  const [notifyOnComments, setNotifyOnComments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/account/settings", {
        saveWatchHistory,
        showLikesPublicly,
        notifyOnNewVideo,
        notifyOnComments,
      });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(messageOf(e, "Could not save your preferences."));
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
      <Toggle
        id="saveWatchHistory"
        label="Save watch history"
        hint="Record which videos you watch so you can resume them later."
        checked={saveWatchHistory}
        onChange={setSaveWatchHistory}
      />
      <Toggle
        id="showLikesPublicly"
        label="Show my liked videos publicly"
        hint="Other people can see the videos you have liked."
        checked={showLikesPublicly}
        onChange={setShowLikesPublicly}
      />
      <Toggle
        id="notifyOnNewVideo"
        label="Notify me about new uploads"
        hint="Get a notification when a channel you follow publishes a video."
        checked={notifyOnNewVideo}
        onChange={setNotifyOnNewVideo}
      />
      <Toggle
        id="notifyOnComments"
        label="Notify me about comment activity"
        hint="Replies to your comments and likes on them."
        checked={notifyOnComments}
        onChange={setNotifyOnComments}
      />
      <div className="flex items-center gap-3">
        <button type="submit" className="dt-btn dt-btn-primary" disabled={busy}>
          {busy ? <SpinnerIcon size={16} /> : null} Save preferences
        </button>
        {saved && <span className="text-sm text-success">Saved.</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </span>
    </label>
  );
}

/* ----------------------------------------------------------------- password */

export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.post("/api/account/password", { currentPassword, newPassword });
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      // Every session is revoked; send the user to sign in again. A hard
      // navigation makes sure no cached authenticated payload remains client-side.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard reload after the session changes
      window.location.href = "/login";
    } catch (e) {
      setError(fieldError(e, "newPassword") ?? messageOf(e, "Could not change your password."));
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="currentPassword" className="dt-label">
            Current password
          </label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            className="dt-input w-full"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="newPassword" className="dt-label">
            New password
          </label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            className="dt-input w-full"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className="mt-1 text-xs text-subtle">At least 10 characters with upper, lower and a number.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="dt-btn dt-btn-primary"
          disabled={busy || !currentPassword || !newPassword}
        >
          {busy ? <SpinnerIcon size={16} /> : null} Change password
        </button>
        {done && <span className="text-sm text-success">Password changed. Signing you out…</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/* ----------------------------------------------------------------- sessions */

export function SessionsList({
  sessions,
}: {
  sessions: Array<{ id: string; userAgent: string | null; lastSeenAt: string; createdAt: string }>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line text-sm">
      {sessions.map((session) => (
        <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-medium">{describeAgent(session.userAgent)}</p>
            <p className="text-xs text-subtle">Started {formatDateTime(session.createdAt)}</p>
          </div>
          <p className="text-xs text-subtle">Last active {formatDateTime(session.lastSeenAt)}</p>
        </li>
      ))}
      {sessions.length === 0 && <li className="py-2 text-sm text-muted">No active sessions.</li>}
    </ul>
  );
}

/** Turns a raw user-agent into something a person can recognise. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser =
    /Firefox\//.test(userAgent) ? "Firefox"
    : /Edg\//.test(userAgent) ? "Edge"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : /curl\//i.test(userAgent) ? "Command-line client"
    : "Browser";
  const os =
    /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X/.test(userAgent) ? "macOS"
    : /Android/.test(userAgent) ? "Android"
    : /Linux/.test(userAgent) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

/* -------------------------------------------------------------- danger zone */

export function DangerZone({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetchJson("/api/account", { password, confirm });
      // The account (and its channel) no longer exists: hard-load the home page
      // so every cached RSC payload is discarded.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard reload after the account is deleted
      window.location.href = "/";
    } catch (e) {
      setError(messageOf(e, "Could not delete your account."));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="dt-btn dt-btn-danger" onClick={() => setOpen(true)}>
        Delete my account
      </button>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-danger">
        This permanently deletes <strong>@{username}</strong>, anonymises its content and signs you out everywhere.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="delete-password" className="dt-label">
            Your password
          </label>
          <input
            id="delete-password"
            type="password"
            autoComplete="current-password"
            className="dt-input w-full"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="delete-confirm" className="dt-label">
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirm"
            className="dt-input w-full"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="DELETE"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="dt-btn dt-btn-danger" disabled={busy || confirm !== "DELETE" || !password}>
          {busy ? <SpinnerIcon size={16} /> : null} Delete account
        </button>
        <button type="button" className="dt-btn dt-btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** DELETE with a JSON body, which `api.del` does not support. */
async function apiFetchJson(path: string, body: unknown): Promise<void> {
  const { apiFetch } = await import("@/lib/api-client");
  await apiFetch(path, { method: "DELETE", body: JSON.stringify(body) });
}
