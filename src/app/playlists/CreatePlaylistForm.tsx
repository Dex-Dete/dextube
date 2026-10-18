"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { SpinnerIcon } from "@/components/icons";

/**
 * Create a playlist.
 *
 * Posts to the same endpoint the API exposes and refreshes the server-rendered
 * list afterwards, so the new playlist appears with its real (server-assigned)
 * id rather than an optimistic placeholder.
 */
export function CreatePlaylistForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "UNLISTED" | "PUBLIC">("PRIVATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/playlists", { title: trimmed, visibility });
      setTitle("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create that playlist.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="dt-btn dt-btn-secondary" onClick={() => setOpen(true)}>
        New playlist
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="new-playlist-title" className="dt-visually-hidden">
        Playlist title
      </label>
      <input
        id="new-playlist-title"
        className="dt-input !w-52"
        value={title}
        maxLength={120}
        autoFocus
        placeholder="Playlist title"
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor="new-playlist-visibility" className="dt-visually-hidden">
        Visibility
      </label>
      <select
        id="new-playlist-visibility"
        className="dt-input !w-auto"
        value={visibility}
        onChange={(event) => setVisibility(event.target.value as typeof visibility)}
      >
        <option value="PRIVATE">Private</option>
        <option value="UNLISTED">Unlisted</option>
        <option value="PUBLIC">Public</option>
      </select>
      <button type="submit" className="dt-btn dt-btn-primary" disabled={busy || title.trim().length === 0}>
        {busy ? <SpinnerIcon size={16} /> : null} Create
      </button>
      <button
        type="button"
        className="dt-btn dt-btn-ghost"
        onClick={() => {
          setOpen(false);
          setTitle("");
          setError(null);
        }}
      >
        Cancel
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
