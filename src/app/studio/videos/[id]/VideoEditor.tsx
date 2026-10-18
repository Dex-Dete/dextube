"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";
import { mediaUrl, streamUrl } from "@/lib/media-url";
import { videoCategories } from "@/lib/validation";
import { formatBytes, formatCount, formatDate, formatDuration } from "@/lib/format";
import { PlayIcon, TrashIcon } from "@/components/icons";

export interface EditableVideo {
  id: string;
  title: string;
  description: string;
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  status: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  category: string | null;
  tags: string[];
  allowComments: boolean;
  madeForKids: boolean;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  processingError: string | null;
  sizeBytes: number | null;
  playbackKey: string | null;
}

interface FormState {
  title: string;
  description: string;
  visibility: EditableVideo["visibility"];
  category: string;
  tags: string;
  language: string;
  allowComments: boolean;
  madeForKids: boolean;
}

function initialForm(video: EditableVideo): FormState {
  return {
    title: video.title,
    description: video.description,
    visibility: video.visibility,
    category: video.category ?? "",
    tags: video.tags.join(", "),
    language: "",
    allowComments: video.allowComments,
    madeForKids: video.madeForKids,
  };
}

/** Picks the first message for `name`, tolerating nested keys like `tags.0`. */
function errorFor(errors: Record<string, string>, name: string): string | undefined {
  if (errors[name]) return errors[name];
  const nested = Object.entries(errors).find(([key]) => key === name || key.startsWith(`${name}.`));
  return nested?.[1];
}

/**
 * Edit + lifecycle controls for a single video.
 *
 * Saving sends only the fields the creator actually edited (language is only
 * included when non-empty, since the studio record does not carry it back).
 * Publishing is disabled until processing is READY, mirroring the service rule,
 * and every action surfaces the server's field-level validation errors.
 */
export function VideoEditor({ video: initialVideo }: { video: EditableVideo }) {
  const router = useRouter();
  const [video, setVideo] = useState(initialVideo);
  const [form, setForm] = useState<FormState>(() => initialForm(initialVideo));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<string | null>(null);

  // Keep in sync when the server sends a newer record (e.g. after router.refresh()).
  // Adjusting state during render is React's documented alternative to a
  // syncing effect: it is cheaper (no extra commit) and the identity check on
  // `initialVideo` makes it terminate.
  const [syncedVideo, setSyncedVideo] = useState(initialVideo);
  if (syncedVideo !== initialVideo) {
    setSyncedVideo(initialVideo);
    setVideo(initialVideo);
    setForm(initialForm(initialVideo));
  }

  const patch = (values: Partial<FormState>) => setForm((current) => ({ ...current, ...values }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    setMessage(null);
    setSaving(true);
    try {
      const parsedTags = form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20);
      const payload: Record<string, unknown> = {
        title: form.title,
        description: form.description,
        visibility: form.visibility,
        tags: parsedTags,
        allowComments: form.allowComments,
        madeForKids: form.madeForKids,
      };
      if (form.category) payload.category = form.category;
      if (form.language.trim()) payload.language = form.language.trim();

      const res = await api.patch<{ video: EditableVideo }>(`/api/studio/videos/${video.id}`, payload);
      setVideo(res.video);
      setForm(initialForm(res.video));
      setMessage({ tone: "success", text: "Changes saved." });
      router.refresh();
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage({
        tone: "error",
        text: error instanceof ApiClientError ? error.message : "Could not save your changes.",
      });
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setAction("publish");
    setMessage(null);
    try {
      const visibility = form.visibility === "PRIVATE" ? "PUBLIC" : form.visibility;
      const res = await api.post<{ video: EditableVideo }>(`/api/studio/videos/${video.id}/publish`, { visibility });
      setVideo(res.video);
      setForm((current) => ({ ...current, visibility: res.video.visibility }));
      setMessage({ tone: "success", text: `Published as ${res.video.visibility.toLowerCase()}.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof ApiClientError ? error.message : "Could not publish the video." });
    } finally {
      setAction(null);
    }
  };

  const unpublish = async () => {
    setAction("unpublish");
    setMessage(null);
    try {
      const res = await api.del<{ video: EditableVideo }>(`/api/studio/videos/${video.id}/publish`);
      setVideo(res.video);
      setForm((current) => ({ ...current, visibility: res.video.visibility }));
      setMessage({ tone: "info", text: "The video is private again." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof ApiClientError ? error.message : "Could not unpublish the video." });
    } finally {
      setAction(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${video.title}”? This cannot be undone from Studio.`)) return;
    setAction("delete");
    setMessage(null);
    try {
      await api.del(`/api/studio/videos/${video.id}`);
      router.push("/studio/videos");
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof ApiClientError ? error.message : "Could not delete the video." });
      setAction(null);
    }
  };

  const canPublish = video.status === "READY";
  const busy = saving || action !== null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      {/* ------------------------------------------------------------- form */}
      <form className="dt-card flex flex-col gap-4 p-4 sm:p-5" onSubmit={save} noValidate>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Details</h2>
          <span className="text-xs text-subtle">Updated {formatDate(video.updatedAt)}</span>
        </div>

        {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}

        <Field
          label="Title"
          name="title"
          value={form.title}
          onChange={(value) => patch({ title: value })}
          error={errorFor(errors, "title")}
          required
          maxLength={120}
          disabled={saving}
        />

        <Field
          label="Description"
          name="description"
          value={form.description}
          onChange={(value) => patch({ description: value })}
          error={errorFor(errors, "description")}
          multiline
          rows={8}
          maxLength={20000}
          disabled={saving}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="dt-label" htmlFor="video-visibility">
              Visibility
            </label>
            <select
              id="video-visibility"
              className="dt-input"
              value={form.visibility}
              disabled={saving}
              onChange={(event) => patch({ visibility: event.target.value as FormState["visibility"] })}
            >
              <option value="PRIVATE">Private — only you</option>
              <option value="UNLISTED">Unlisted — anyone with the link</option>
              <option value="PUBLIC">Public — everyone</option>
            </select>
          </div>

          <div>
            <label className="dt-label" htmlFor="video-category">
              Category
            </label>
            <select
              id="video-category"
              className="dt-input"
              value={form.category}
              disabled={saving}
              onChange={(event) => patch({ category: event.target.value })}
              aria-invalid={errorFor(errors, "category") ? true : undefined}
            >
              <option value="">No category</option>
              {videoCategories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {errorFor(errors, "category") && <p className="mt-1 text-xs text-danger">{errorFor(errors, "category")}</p>}
          </div>
        </div>

        <Field
          label="Tags"
          name="tags"
          value={form.tags}
          onChange={(value) => patch({ tags: value })}
          error={errorFor(errors, "tags")}
          hint="Comma-separated, up to 20 tags. Tags cannot contain <, > or #."
          disabled={saving}
        />

        <Field
          label="Language"
          name="language"
          value={form.language}
          onChange={(value) => patch({ language: value })}
          error={errorFor(errors, "language")}
          hint="Optional BCP-47 code such as “en” or “pt-BR”. Leave blank to keep the current language."
          placeholder="en"
          maxLength={12}
          disabled={saving}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="dt-label">Audience and comments</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.allowComments}
              disabled={saving}
              onChange={(event) => patch({ allowComments: event.target.checked })}
            />
            Allow comments on this video
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.madeForKids}
              disabled={saving}
              onChange={(event) => patch({ madeForKids: event.target.checked })}
            />
            Made for kids
          </label>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="dt-btn dt-btn-primary" disabled={busy || form.title.trim() === ""}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <Link href="/studio/videos" className="dt-btn dt-btn-ghost">
            Back to videos
          </Link>
        </div>
      </form>

      {/* ------------------------------------------------------- status panel */}
      <div className="flex flex-col gap-5">
        <section className="dt-card p-4" aria-labelledby="status-heading">
          <h2 id="status-heading" className="text-sm font-bold">
            Status
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-subtle">Processing</dt>
              <dd className="font-semibold">{video.status.charAt(0) + video.status.slice(1).toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Visibility</dt>
              <dd className="font-semibold">{video.visibility.charAt(0) + video.visibility.slice(1).toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Duration</dt>
              <dd className="font-semibold tabular-nums">{formatDuration(video.durationSec)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">File size</dt>
              <dd className="font-semibold tabular-nums">{formatBytes(video.sizeBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Views</dt>
              <dd className="font-semibold tabular-nums">{formatCount(video.viewCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Likes</dt>
              <dd className="font-semibold tabular-nums">{formatCount(video.likeCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Comments</dt>
              <dd className="font-semibold tabular-nums">{formatCount(video.commentCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Published</dt>
              <dd className="font-semibold">{video.publishedAt ? formatDate(video.publishedAt) : "Not published"}</dd>
            </div>
          </dl>

          {video.status === "FAILED" && video.processingError && (
            <p className="dt-alert dt-alert-error mt-3" role="alert">
              {video.processingError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {video.visibility === "PRIVATE" ? (
              <button
                type="button"
                className="dt-btn dt-btn-primary"
                disabled={busy || !canPublish}
                title={canPublish ? undefined : "Only videos that have finished processing can be published."}
                onClick={() => void publish()}
              >
                {action === "publish" ? "Publishing…" : "Publish"}
              </button>
            ) : (
              <button type="button" className="dt-btn dt-btn-secondary" disabled={busy} onClick={() => void unpublish()}>
                {action === "unpublish" ? "Unpublishing…" : "Unpublish"}
              </button>
            )}
            {video.status === "READY" && (
              <Link href={`/watch/${video.id}`} className="dt-btn dt-btn-outline">
                <PlayIcon size={16} /> Watch
              </Link>
            )}
            <button
              type="button"
              className="dt-btn dt-btn-danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              <TrashIcon size={16} /> {action === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </section>

        <section className="dt-card p-4" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="text-sm font-bold">
            Preview
          </h2>
          <div className="mt-3">
            {video.playbackKey ? (
              <video
                controls
                preload="metadata"
                className="dt-aspect-video w-full rounded-lg"
                style={{ background: "#000" }}
                poster={mediaUrl(video.thumbnailKey) ?? undefined}
                src={streamUrl(video.playbackKey) ?? undefined}
                aria-label={`Preview of ${video.title}`}
              >
                Your browser cannot play this video.{" "}
                <a href={streamUrl(video.playbackKey) ?? "#"} className="dt-link">
                  Download it instead
                </a>
                .
              </video>
            ) : (
              <p className="text-sm text-subtle">A preview player appears here once processing finishes.</p>
            )}
          </div>
          <p className="mt-2 text-xs text-subtle">
            {video.isShort ? "Classified as a Short. " : ""}
            {video.allowComments ? "Comments are enabled." : "Comments are disabled."}
          </p>
        </section>
      </div>
    </div>
  );
}
