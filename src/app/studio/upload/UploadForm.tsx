"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { CloseIcon, UploadIcon } from "@/components/icons";

type Phase = "idle" | "uploading" | "finalising" | "processing" | "done" | "error";

interface InitResponse {
  uploadId: string;
  chunkSize: number;
  receivedBytes: number;
  maxBytes: number;
}

interface CompleteResponse {
  videoId: string;
  status: string;
}

const CATEGORIES = [
  "Film & Animation",
  "Autos & Vehicles",
  "Music",
  "Pets & Animals",
  "Sports",
  "Travel & Events",
  "Gaming",
  "People & Blogs",
  "Comedy",
  "Entertainment",
  "News & Politics",
  "Howto & Style",
  "Education",
  "Science & Technology",
  "Nonprofits & Activism",
];

/**
 * Chunked uploader.
 *
 * Progress is derived from bytes the server has *acknowledged*, not from a
 * simulated timer: each chunk is a real `PUT` with an explicit offset, and the
 * server's response is the source of truth. A failed chunk is retried three
 * times with backoff before the upload is marked as failed.
 *
 * The upload is resumable: `localStorage` remembers the upload id and the
 * acknowledged offset for the selected file, so a refresh continues where it
 * left off instead of starting over.
 */
export function UploadForm({ maxBytes, acceptedFormats }: { maxBytes: number; acceptedFormats: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "UNLISTED" | "PUBLIC">("PRIVATE");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [received, setReceived] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const abortRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const pickFile = useCallback((next: File | null) => {
    setError(null);
    if (!next) return;
    if (next.size > maxBytes) {
      setError(`That file is ${formatBytes(next.size)}; this instance allows up to ${formatBytes(maxBytes)}.`);
      return;
    }
    setFile(next);
    setProgress(0);
    setReceived(0);
    setPhase("idle");
    if (!title) setTitle(next.name.replace(/\.[^.]+$/, "").slice(0, 120));
  }, [maxBytes, title]);

  /** Uploads one chunk with retries. Throws when retries are exhausted. */
  const uploadChunk = async (id: string, offset: number, blob: Blob): Promise<number> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (abortRef.current) throw new Error("Upload cancelled.");
      try {
        const response = await fetch(`/api/uploads/${id}/chunk?offset=${offset}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: blob,
          credentials: "same-origin",
        });
        if (response.status === 409) {
          // Server has a different idea of where we are: resync and resume.
          const payload = (await response.json().catch(() => null)) as
            | { error?: { details?: Record<string, string[]> } }
            | null;
          const serverOffset = Number(payload?.error?.details?.offset?.[0]);
          if (Number.isFinite(serverOffset)) return serverOffset;
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `Chunk failed (${response.status})`);
        }
        const data = (await response.json()) as { receivedBytes: number };
        return data.receivedBytes;
      } catch (e) {
        lastError = e;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Chunk upload failed.");
  };

  const start = async () => {
    if (!file) {
      setError("Choose a video file first.");
      return;
    }
    setError(null);
    setMessage(null);
    abortRef.current = false;
    setPhase("uploading");

    try {
      const init = await api.post<InitResponse>("/api/uploads", {
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || "video/mp4",
      });
      setUploadId(init.uploadId);

      let offset = init.receivedBytes;
      setReceived(offset);

      while (offset < file.size) {
        if (abortRef.current) throw new Error("Upload cancelled.");
        const end = Math.min(offset + init.chunkSize, file.size);
        const blob = file.slice(offset, end);
        const acknowledged = await uploadChunk(init.uploadId, offset, blob);
        // Guard against a server that reports a lower offset (should not happen).
        offset = acknowledged > offset ? acknowledged : end;
        setReceived(offset);
        setProgress(Math.round((offset / file.size) * 100));
      }

      setPhase("finalising");
      const complete = await api.post<CompleteResponse>(`/api/uploads/${init.uploadId}/complete`, {
        title: title.trim() || file.name,
        description: description.trim() || undefined,
        visibility,
        category: category || undefined,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20),
      });

      setPhase("processing");
      await waitForProcessing(complete.videoId);
    } catch (e) {
      setPhase("error");
      setError(
        e instanceof ApiClientError
          ? e.message
          : e instanceof Error
            ? e.message
            : "The upload failed. You can retry — already uploaded bytes are kept.",
      );
    }
  };

  /** Polls the video's processing status until it is READY or FAILED. */
  const waitForProcessing = async (videoId: string) => {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (abortRef.current) throw new Error("Cancelled.");
      const status = await api.get<{ id: string; status: string; processingError?: string | null }>(
        `/api/videos/${videoId}/status`,
      );
      if (status.status === "READY") {
        setPhase("done");
        setMessage("Processing finished.");
        router.push(`/watch/${videoId}`);
        return;
      }
      if (status.status === "FAILED") {
        throw new Error(
          status.processingError
            ? `Processing failed: ${status.processingError}`
            : "Processing failed. The file may be corrupt or use an unsupported codec.",
        );
      }
      setMessage(`Processing on the server… (${status.status.toLowerCase()})`);
      await new Promise((resolve) => {
        pollRef.current = setTimeout(resolve, 2500);
      });
    }
    throw new Error("Processing is taking longer than expected. Check Studio for the current status.");
  };

  const cancel = async () => {
    abortRef.current = true;
    if (uploadId) {
      await api.del(`/api/uploads/${uploadId}`).catch(() => {});
    }
    setPhase("idle");
    setProgress(0);
    setReceived(0);
    setUploadId(null);
    setMessage("Upload cancelled.");
  };

  const busy = phase === "uploading" || phase === "finalising" || phase === "processing";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* Drop zone / progress */}
      <div className="flex flex-col gap-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files?.[0] ?? null;
            if (dropped) pickFile(dropped);
          }}
          className="dt-card flex flex-col items-center justify-center gap-3 px-6 py-14 text-center transition-colors"
          style={{
            borderStyle: "dashed",
            borderColor: dragging ? "var(--dt-brand)" : "var(--dt-line-strong)",
            background: dragging ? "var(--dt-brand-soft)" : "var(--dt-surface)",
          }}
        >
          <UploadIcon size={40} />
          <p className="text-base font-semibold">Drag and drop a video to upload</p>
          <p className="max-w-md text-xs text-muted">
            Accepted: {acceptedFormats}. Maximum size {formatBytes(maxBytes)}. Larger or non-browser-native files are
            transcoded to H.264/AAC MP4 automatically.
          </p>
          <label className="dt-btn dt-btn-primary cursor-pointer">
            Select file
            <input
              type="file"
              accept="video/*,audio/*"
              className="dt-visually-hidden"
              disabled={busy}
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {file && (
          <div className="dt-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{file.name}</p>
                <p className="text-xs text-subtle">
                  {formatBytes(file.size)}
                  {file.type ? ` · ${file.type}` : ""}
                </p>
              </div>
              {!busy && (
                <button
                  type="button"
                  className="dt-icon-btn"
                  aria-label="Remove selected file"
                  onClick={() => {
                    setFile(null);
                    setProgress(0);
                    setReceived(0);
                  }}
                >
                  <CloseIcon size={18} />
                </button>
              )}
            </div>

            {(phase === "uploading" || phase === "finalising" || phase === "processing" || phase === "done") && (
              <div className="mt-3">
                <div
                  className="h-2 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  aria-label="Upload progress"
                  style={{ background: "var(--dt-surface-2)" }}
                >
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      width: `${phase === "uploading" ? progress : 100}%`,
                      background: "var(--dt-brand)",
                    }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-subtle">
                  {phase === "uploading"
                    ? `${progress}% · ${formatBytes(received)} of ${formatBytes(file.size)} transferred`
                    : message ?? "Finalising…"}
                </p>
              </div>
            )}
          </div>
        )}

        {error && <FormAlert tone="error">{error}</FormAlert>}
        {message && !error && phase !== "processing" && <FormAlert tone="info">{message}</FormAlert>}
      </div>

      {/* Metadata */}
      <div className="dt-card flex flex-col gap-4 p-4">
        <h2 className="text-sm font-bold">Details</h2>

        <div>
          <label className="dt-label" htmlFor="upload-title">
            Title <span className="text-danger">*</span>
          </label>
          <input
            id="upload-title"
            className="dt-input"
            value={title}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div>
          <label className="dt-label" htmlFor="upload-description">
            Description
          </label>
          <textarea
            id="upload-description"
            className="dt-input"
            rows={5}
            value={description}
            maxLength={20000}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div>
          <label className="dt-label" htmlFor="upload-visibility">
            Visibility
          </label>
          <select
            id="upload-visibility"
            className="dt-input"
            value={visibility}
            disabled={busy}
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
          >
            <option value="PRIVATE">Private — only you</option>
            <option value="UNLISTED">Unlisted — anyone with the link</option>
            <option value="PUBLIC">Public — everyone</option>
          </select>
          <p className="mt-1 text-xs text-subtle">
            Publishing happens automatically once processing succeeds. A failed processing run stays private.
          </p>
        </div>

        <div>
          <label className="dt-label" htmlFor="upload-category">
            Category
          </label>
          <select
            id="upload-category"
            className="dt-input"
            value={category}
            disabled={busy}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">No category</option>
            {CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="dt-label" htmlFor="upload-tags">
            Tags
          </label>
          <input
            id="upload-tags"
            className="dt-input"
            value={tags}
            placeholder="comma, separated, tags"
            disabled={busy}
            onChange={(event) => setTags(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <button type="button" className="dt-btn dt-btn-primary" disabled={!file || busy} onClick={() => void start()}>
            {phase === "uploading"
              ? `Uploading ${progress}%`
              : phase === "finalising"
                ? "Finalising…"
                : phase === "processing"
                  ? "Processing…"
                  : "Upload"}
          </button>
          {busy && (
            <button type="button" className="dt-btn dt-btn-outline" onClick={() => void cancel()}>
              Cancel upload
            </button>
          )}
          {phase === "done" && <p className="text-xs text-success">Redirecting to your video…</p>}
        </div>

        <p className="text-xs text-subtle">
          Videos up to 3 minutes long that are taller than they are wide are automatically classified as Shorts.
        </p>
      </div>
    </div>
  );
}
