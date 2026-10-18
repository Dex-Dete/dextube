"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { formatBytes, formatCount, formatDateTime, formatDuration } from "@/lib/format";
import { SpinnerIcon } from "@/components/icons";

type ImportItemStatus = "PENDING" | "IMPORTING" | "METADATA_ONLY" | "IMPORTED" | "SKIPPED_DUPLICATE" | "FAILED";
type ImportSourceStatus = "DRAFT" | "PREVIEW" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";

interface ImportCounts {
  total: number;
  pending: number;
  importing: number;
  imported: number;
  metadataOnly: number;
  duplicates: number;
  failed: number;
}

interface ImportItemSummary {
  id: string;
  externalId: string;
  position: number;
  title: string;
  description: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  attribution: string | null;
  canonicalUrl: string;
  status: ImportItemStatus;
  mediaAuthorized: boolean;
  attempts: number;
  lastError: string | null;
  videoId: string | null;
}

interface ImportSourceSummary {
  id: string;
  kind: string;
  sourceUrl: string;
  externalChannelId: string | null;
  title: string | null;
  status: ImportSourceStatus;
  authorizationBasis: string;
  scopeLimit: number;
  estimatedItems: number | null;
  counts: ImportCounts;
  bytesImported: number;
  limitations: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ImportStorageSummary {
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

interface PreviewResult {
  kind: string;
  title: string | null;
  externalChannelId: string | null;
  canonicalUrl: string;
  entries: ImportItemSummary[];
  limitations: string[];
  estimatedBytes: number;
}

function processedCount(counts: ImportCounts): number {
  return counts.imported + counts.metadataOnly + counts.duplicates + counts.failed;
}

function ImportProgress({ counts, status }: { counts: ImportCounts; status: ImportSourceStatus }) {
  const processed = processedCount(counts);
  const percent = counts.total > 0 ? Math.min(100, (processed / counts.total) * 100) : 0;
  const active = status === "RUNNING" || status === "PAUSED";
  return (
    <div className="mt-2 min-w-[180px]" aria-label={`Import progress: ${processed} of ${counts.total} entries`}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-subtle">
        <span>{processed}/{counts.total} processed</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--dt-line)]">
        <div
          className={`h-full bg-[var(--dt-accent)] transition-[width] ${active && processed === 0 ? "animate-pulse" : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Plain-language meaning of every item state, shown once above the table. */
const ITEM_STATUS_HELP: Record<ImportItemStatus, string> = {
  PENDING: "Waiting to be processed.",
  IMPORTING: "Being processed right now.",
  METADATA_ONLY: "Expected metadata-only result: no authorized media file was supplied, so 0 bytes were copied.",
  IMPORTED: "Media was copied and a DEXTube video was created.",
  SKIPPED_DUPLICATE: "An identical entry was already imported by another source, so it was not copied again.",
  FAILED: "Processing failed; the error is shown for this entry. Retry failed entries to try again.",
};

const SOURCE_STATUS_STYLE: Record<ImportSourceStatus, string> = {
  DRAFT: "",
  PREVIEW: "",
  RUNNING: "dt-badge-warning",
  PAUSED: "dt-badge-warning",
  COMPLETED: "dt-badge-success",
  FAILED: "dt-badge-danger",
  CANCELLED: "",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The import console.
 *
 * Every control maps to a real endpoint; there is no optimistic fake. While a
 * source is `RUNNING` this polls `GET /api/admin/import/sources/:id` every
 * 2000 ms — a simple, deliberately unadorned poll, since the run endpoint itself
 * is synchronous and the poll only kicks in when a run was started elsewhere or
 * is still settling.
 */
export function AdminImportClient({
  initialSources,
  initialStorage,
  maxItems,
  maxConcurrency,
  youtubeApiKeyConfigured,
  youtubeOwnerVerificationConfigured,
}: {
  initialSources: ImportSourceSummary[];
  initialStorage: ImportStorageSummary;
  maxItems: number;
  maxConcurrency: number;
  youtubeApiKeyConfigured: boolean;
  youtubeOwnerVerificationConfigured: boolean;
}) {
  const [input, setInput] = useState("");
  const [scopeLimit, setScopeLimit] = useState("10");
  const [basis, setBasis] = useState("");
  const [mediaAuthorized, setMediaAuthorized] = useState(false);
  const [concurrency, setConcurrency] = useState(String(Math.min(2, maxConcurrency)));

  const [sources, setSources] = useState<ImportSourceSummary[]>(initialSources);
  const [storage, setStorage] = useState<ImportStorageSummary>(initialStorage);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<{ source: ImportSourceSummary; items: ImportItemSummary[] } | null>(null);
  const [busy, setBusy] = useState<"preview" | "start" | "action" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteMedia, setDeleteMedia] = useState(false);

  const parseScope = () => {
    const n = Number.parseInt(scopeLimit, 10);
    return Number.isFinite(n) ? Math.min(maxItems, Math.max(1, n)) : 1;
  };
  const parseConcurrency = () => {
    const n = Number.parseInt(concurrency, 10);
    return Number.isFinite(n) ? Math.min(maxConcurrency, Math.max(1, n)) : 1;
  };

  const loadSource = useCallback(async (id: string) => {
    const result = await api.get<{ source: ImportSourceSummary; items: ImportItemSummary[]; storage: ImportStorageSummary }>(
      `/api/admin/import/sources/${id}`,
    );
    setSelected(result);
    setStorage(result.storage);
    setSources((current) => current.map((row) => (row.id === result.source.id ? result.source : row)));
    return result;
  }, []);

  const runningId =
    sources.find((source) => source.status === "RUNNING")?.id ??
    (selected?.source.status === "RUNNING" ? selected.source.id : null);

  // Simple 2000 ms poll while something is running. Depends only on the id, so
  // a state update from a tick does not restart the interval storm.
  useEffect(() => {
    if (!runningId) return;
    let active = true;
    const tick = async () => {
      try {
        const result = await api.get<{ source: ImportSourceSummary; items: ImportItemSummary[]; storage: ImportStorageSummary }>(
          `/api/admin/import/sources/${runningId}`,
        );
        if (!active) return;
        setSelected((current) => (current?.source.id === result.source.id ? result : current));
        setStorage(result.storage);
        setSources((current) => current.map((row) => (row.id === result.source.id ? result.source : row)));
      } catch {
        /* a transient poll failure is not worth a modal; the next tick retries */
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runningId]);

  async function doPreview() {
    if (busy || !input.trim()) return;
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<PreviewResult>("/api/admin/import/preview", {
        input: input.trim(),
        scopeLimit: parseScope(),
      });
      setPreview(result);
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e, "Could not preview that source."));
    } finally {
      setBusy(null);
    }
  }

  async function startImport() {
    if (busy || !input.trim()) return;
    setBusy("start");
    setError(null);
    setNotice(null);
    try {
      const created = await api.post<{ source: ImportSourceSummary; items: ImportItemSummary[]; limitations: string[] }>(
        "/api/admin/import/sources",
        {
          input: input.trim(),
          scopeLimit: parseScope(),
          authorizationBasis: basis,
          mediaAuthorized,
          concurrency: parseConcurrency(),
        },
      );
      // The server is now processing this source. This row is immediately
      // marked RUNNING, then replaced by polled database state; the bar below
      // never invents byte or item progress.
      setSources((current) => [
        { ...created.source, status: "RUNNING" },
        ...current.filter((row) => row.id !== created.source.id),
      ]);
      const final = await api.post<ImportSourceSummary>(`/api/admin/import/sources/${created.source.id}/run`);
      setSources((current) => [final, ...current.filter((row) => row.id !== final.id)]);
      await loadSource(final.id);
      setNotice(
        `Import finished: ${final.counts.imported} imported, ${final.counts.metadataOnly} metadata-only, ` +
          `${final.counts.duplicates} duplicate, ${final.counts.failed} failed.`,
      );
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e, "Could not start the import."));
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: "cancel" | "retry") {
    if (!selected || busy) return;
    setBusy("action");
    setError(null);
    setNotice(null);
    try {
      const summary = await api.post<ImportSourceSummary>(`/api/admin/import/sources/${selected.source.id}/${action}`);
      await loadSource(summary.id);
    } catch (e) {
      setError(errorMessage(e, action === "cancel" ? "Could not cancel the import." : "Could not retry failed entries."));
    } finally {
      setBusy(null);
    }
  }

  async function doDelete() {
    if (!selected || busy) return;
    setBusy("action");
    setError(null);
    setNotice(null);
    try {
      const query = deleteMedia ? "?deleteMedia=1" : "";
      const result = await api.del<{ removedItems: number; keptVideos: number; deletedVideos: number }>(
        `/api/admin/import/sources/${selected.source.id}${query}`,
      );
      setSources((current) => current.filter((row) => row.id !== selected.source.id));
      setSelected(null);
      setConfirmDelete(false);
      setDeleteMedia(false);
      setNotice(
        `Import deleted: ${formatCount(result.removedItems)} entr${result.removedItems === 1 ? "y" : "ies"} removed, ` +
          `${result.keptVideos} video(s) kept, ${result.deletedVideos} deleted.`,
      );
    } catch (e) {
      setError(errorMessage(e, "Could not delete the import."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void doPreview();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <div>
            <label htmlFor="import-input" className="dt-label">
              Channel / playlist URL or creator-export path
            </label>
            <input
              id="import-input"
              className="dt-input w-full"
              value={input}
              autoComplete="off"
              placeholder="https://www.youtube.com/@channel  ·  my-export/manifest.json"
              onChange={(event) => setInput(event.target.value)}
            />
            <p className="mt-1 text-xs text-subtle">
              {youtubeApiKeyConfigured
                ? "A YouTube API key is configured, so the whole channel/playlist is reachable."
                : "No YOUTUBE_API_KEY: the official public feed provides the latest 15 entries. This is an expected metadata-only mode; YouTube media is never downloaded."}
            </p>
          </div>
          <div>
            <label htmlFor="import-scope" className="dt-label">
              Scope limit (max {maxItems})
            </label>
            <input
              id="import-scope"
              className="dt-input w-full"
              inputMode="numeric"
              value={scopeLimit}
              onChange={(event) => setScopeLimit(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="import-concurrency" className="dt-label">
              Concurrency (max {maxConcurrency})
            </label>
            <input
              id="import-concurrency"
              className="dt-input w-full"
              inputMode="numeric"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            />
          </div>
        </div>

        <div>
          <label htmlFor="import-basis" className="dt-label">
            Authorization basis
          </label>
          <textarea
            id="import-basis"
            className="dt-input w-full"
            rows={2}
            value={basis}
            placeholder="Who authorized copying the original media, and on what terms (required to copy media)."
            onChange={(event) => setBasis(event.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mediaAuthorized}
            onChange={(event) => setMediaAuthorized(event.target.checked)}
          />
          Media is authorized — copy the creator&apos;s original files (creator exports only)
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="dt-btn dt-btn-secondary" disabled={busy !== null || !input.trim()}>
            {busy === "preview" ? <SpinnerIcon size={16} /> : null} Preview
          </button>
          <button
            type="button"
            className="dt-btn dt-btn-primary"
            disabled={busy !== null || !input.trim()}
            onClick={() => void startImport()}
          >
            {busy === "start" ? <SpinnerIcon size={16} /> : null} Start import
          </button>
          <a href="/api/admin/youtube/oauth/start" className="dt-btn dt-btn-secondary">
            {youtubeOwnerVerificationConfigured ? "Verify YouTube ownership" : "Configure YouTube ownership OAuth"}
          </a>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {notice && <p className="text-sm text-success">{notice}</p>}
      </form>

      {preview && <PreviewPanel preview={preview} />}

      <section aria-label="Import storage" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <h3 className="font-bold">Import storage</h3>
          <span className="text-muted">{formatBytes(storage.usedBytes)} used · {formatBytes(storage.availableBytes)} available</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-[var(--dt-line)]"
          role="progressbar"
          aria-label="Import storage used"
          aria-valuemin={0}
          aria-valuemax={storage.quotaBytes}
          aria-valuenow={storage.usedBytes}
        >
          <div
            className="h-full bg-[var(--dt-accent)] transition-[width]"
            style={{ width: `${storage.quotaBytes ? Math.min(100, (storage.usedBytes / storage.quotaBytes) * 100) : 0}%` }}
          />
        </div>
        <p className="text-xs text-subtle">{formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)} configured import capacity</p>
      </section>

      <section aria-label="Import sources" className="flex flex-col gap-2">
        <h3 className="text-sm font-bold">Sources</h3>
        {sources.length === 0 ? (
          <p className="text-sm text-muted">No imports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="dt-visually-hidden">Import sources</caption>
              <thead>
                <tr className="text-xs text-subtle">
                  <th scope="col" className="px-3 py-2 font-semibold">Source</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Counts</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Imported</th>
                  <th scope="col" className="px-3 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id} className="border-t align-top" style={{ borderColor: "var(--dt-line)" }}>
                    <td className="px-3 py-2">
                      <p className="font-medium">{source.title ?? source.externalChannelId ?? source.sourceUrl}</p>
                      <p className="text-xs text-subtle">{source.kind}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`dt-badge ${SOURCE_STATUS_STYLE[source.status]}`}>{source.status}</span>
                      {source.lastError && <p className="mt-1 max-w-[240px] text-xs text-danger">{source.lastError}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {source.counts.imported} imported · {source.counts.metadataOnly} metadata ·{" "}
                      {source.counts.duplicates} dup · {source.counts.failed} failed · {source.counts.pending} pending
                      <ImportProgress counts={source.counts} status={source.status} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted">{formatBytes(source.bytesImported)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                        onClick={() => void loadSource(source.id)}
                      >
                        View entries
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section aria-label="Entries" className="flex flex-col gap-2 border-t pt-4" style={{ borderColor: "var(--dt-line)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold">
                {selected.source.title ?? selected.source.externalChannelId ?? selected.source.sourceUrl}
              </h3>
              <p className="text-xs text-subtle">
                <span className={`dt-badge ${SOURCE_STATUS_STYLE[selected.source.status]}`}>{selected.source.status}</span>{" "}
                {selected.items.length} entries · {formatBytes(selected.source.bytesImported)} copied
              </p>
              <ImportProgress counts={selected.source.counts} status={selected.source.status} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selected.source.status === "RUNNING" && (
                <button
                  type="button"
                  className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                  disabled={busy !== null}
                  onClick={() => void runAction("cancel")}
                >
                  Cancel
                </button>
              )}
              {selected.source.counts.failed > 0 && selected.source.status !== "RUNNING" && (
                <button
                  type="button"
                  className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                  disabled={busy !== null}
                  onClick={() => void runAction("retry")}
                >
                  Retry failed
                </button>
              )}
              {!confirmDelete && (
                <button
                  type="button"
                  className="dt-btn dt-btn-danger !px-3 !py-1 text-[13px]"
                  disabled={busy !== null}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete import
                </button>
              )}
            </div>
          </div>

          {confirmDelete && (
            <div className="rounded-md border p-3" style={{ borderColor: "var(--dt-line)" }}>
              <p className="text-sm">
                Delete this import and its {selected.items.length} entr
                {selected.items.length === 1 ? "y" : "ies"}? This cannot be undone.
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={deleteMedia} onChange={(event) => setDeleteMedia(event.target.checked)} />
                <span className="text-danger">Also delete the videos this import created (destructive)</span>
              </label>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="dt-btn dt-btn-danger !px-3 !py-1 text-[13px]"
                  disabled={busy !== null}
                  onClick={() => void doDelete()}
                >
                  {busy === "action" ? <SpinnerIcon size={14} /> : null} Confirm delete
                </button>
                <button
                  type="button"
                  className="dt-btn dt-btn-ghost !px-3 !py-1 text-[13px]"
                  onClick={() => {
                    setConfirmDelete(false);
                    setDeleteMedia(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="dt-visually-hidden">Entries in this import</caption>
              <thead>
                <tr className="text-xs text-subtle">
                  <th scope="col" className="px-3 py-2 font-semibold">Entry</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Published</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Attempts</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {selected.items.map((item) => (
                  <tr key={item.id} className="border-t align-top" style={{ borderColor: "var(--dt-line)" }}>
                    <td className="px-3 py-2">
                      <p className="font-medium">{item.title}</p>
                      <p className="text-xs text-subtle">{item.externalId}</p>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted">
                      {item.publishedAt ? formatDateTime(item.publishedAt) : "—"}
                      {item.durationSeconds !== null && (
                        <span className="block text-subtle">{formatDuration(item.durationSeconds)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="dt-badge">{item.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{item.attempts}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      <span className="block">{ITEM_STATUS_HELP[item.status]}</span>
                      {item.lastError && <span className="mt-0.5 block text-danger">{item.lastError}</span>}
                      {item.videoId && (
                        <a className="mt-0.5 block text-brand underline" href={`/watch/${item.videoId}`}>
                          Open imported video
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function PreviewPanel({ preview }: { preview: PreviewResult }) {
  return (
    <section aria-label="Preview" className="rounded-md border p-3" style={{ borderColor: "var(--dt-line)" }}>
      <h3 className="text-sm font-bold">
        Preview: {preview.title ?? preview.externalChannelId ?? "source"} ({preview.kind})
      </h3>
      <p className="mt-1 text-xs text-muted">
        {preview.entries.length} entr{preview.entries.length === 1 ? "y" : "ies"} ·{" "}
        {preview.estimatedBytes > 0 ? `${formatBytes(preview.estimatedBytes)} of stated media` : "no media size stated"}
      </p>
      {preview.limitations.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-warning">
          {preview.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="dt-visually-hidden">Previewed entries</caption>
          <thead>
            <tr className="text-xs text-subtle">
              <th scope="col" className="px-3 py-2 font-semibold">Title</th>
              <th scope="col" className="px-3 py-2 font-semibold">Published</th>
              <th scope="col" className="px-3 py-2 font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody>
            {preview.entries.map((entry) => (
              <tr key={entry.id} className="border-t align-top" style={{ borderColor: "var(--dt-line)" }}>
                <td className="px-3 py-2">
                  <p className="font-medium">{entry.title}</p>
                  <p className="text-xs text-subtle">{entry.externalId}</p>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted">
                  {entry.publishedAt ? formatDateTime(entry.publishedAt) : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-muted">
                  {entry.durationSeconds !== null ? formatDuration(entry.durationSeconds) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
