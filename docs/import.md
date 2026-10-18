# Authorized channel and playlist migration

DEXTube can pull a creator's **published metadata** — and, when the operator has
documented permission, their **media** — into an instance. This document states
exactly what is and is not allowed, because the interesting part of a migration
feature is not the fetching, it is the authorisation.

The short version:

> DEXTube reads metadata from sources that publish it deliberately, and it copies
> media **only** from files the operator was given the right to use. It never
> rips, downloads, decrypts, or circumvents an access control, and it never
> invents a video, a track, a subtitle or a download result. An entry without
> permission is kept as `METADATA_ONLY` — a complete, honest outcome, not a
> failure.

---

## 1. Metadata connectors

A connector answers one question: *what does the provider say exists?* It is
chosen from the address the operator pastes (`connectorForInput`), and it is
declared in `src/server/import/index.ts`.

| Connector | Kind | Source | Media? |
| --- | --- | --- | --- |
| `youtubeConnector` | `YOUTUBE_CHANNEL`, `YOUTUBE_PLAYLIST` | YouTube Data API v3 when `YOUTUBE_API_KEY` is set, otherwise the channel's official public Atom feed (`/feeds/videos.xml`) | **never** |
| `creatorExportConnector` | `CREATOR_EXPORT` | A manifest inside `CREATOR_EXPORT_ROOT` supplied by the creator or rights holder | only with a recorded authorization basis |

### 1.1 YouTube

With `YOUTUBE_API_KEY`, metadata comes from the official Data API v3: real video
ids, titles, descriptions, publication dates, durations and thumbnail references,
with real pagination and a stated total. Without a key, DEXTube reads YouTube's
**official public channel/playlist feed**, which is a public, machine-readable
document published by YouTube itself. It carries the same fields for the most
recent **15** entries and no further pages; the connector reports that as a
`limitation` and the admin UI shows it before an import is started. There is no
scraping of watch pages for metadata, and there is **no media download path at
all** — no `youtube-dl`, no signature deciphering, no stream extraction, no
workaround of any kind.

`@handle` resolution uses the Data API when a key is present. Without one, DEXTube
reads the public channel page *only* to learn the channel's own id and title from
its canonical link and `og:title`. That is page metadata, not media, and it is
documented here rather than hidden. Set `YOUTUBE_API_KEY` if you need reliable
resolution of handles and custom names, or more than 15 entries.

### 1.2 Authorized creator exports

The only path by which foreign **media** can enter DEXTube. The operator places a
manifest inside `CREATOR_EXPORT_ROOT` (default `./storage/creator-exports`) and
points the importer at it:

```json
{
  "format": "dextube-creator-export/1",
  "authorization": {
    "basis": "Written permission from the rights holder, 2026-10-18",
    "grantedBy": "Example Media LLC",
    "reference": "email-2026-10-18"
  },
  "channel": { "title": "Example Channel", "externalChannelId": "UC…" },
  "items": [
    {
      "externalId": "abc123",
      "title": "Real title as published",
      "description": "Real description",
      "publishedAt": "2026-10-17T00:00:00Z",
      "durationSeconds": 612,
      "thumbnail": "thumbs/abc123.jpg",
      "source": "media/abc123-master.mp4",
      "renditions": [{ "file": "media/abc123-480p.mp4", "label": "480p", "height": 480 }],
      "audioTracks": [{ "file": "media/abc123-en.m4a", "language": "en", "isDefault": true }],
      "subtitles": [{ "file": "subs/abc123.en.vtt", "language": "en", "kind": "subtitles" }]
    }
  ]
}
```

A manifest with no non-empty `authorization.basis` is **refused**, and so is one
that asks the importer to import media for an entry whose basis is missing. Every
referenced file is resolved relative to the manifest and must stay inside
`CREATOR_EXPORT_ROOT`: `..` traversal, absolute paths and symlink escapes are all
rejected with a `FORBIDDEN` error.

Quality variants, audio tracks, subtitle languages and thumbnails are preserved
**exactly as the export states them**. Nothing is probed, upscaled, renamed or
guessed; a field the export does not state is stored as null.

### 1.3 Admin progress and storage accounting

`/admin/import` is available only to an authenticated `ADMIN` session. Each
source displays a real item progress bar derived from persisted item states
(imported, metadata-only, duplicate, failed and pending). While a run is
active, the page polls the source and updates the bar from the database; it is
not simulated progress. The storage panel reports the exact sum of
`bytesImported`, the configured `STORAGE_QUOTA_BYTES`, and the remaining
capacity.

Metadata-only results are successful and expected when the source does not
provide an authorized media file. There is no supported bypass for YouTube
media restrictions or a missing API key. The official feed fallback still
records real public metadata; an API key only expands metadata coverage and
pagination. Media requires an authorized creator export.

### 1.4 Verified owner workflow

When `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET` and the registered
callback URL are configured, the admin import page offers YouTube OAuth
ownership verification. DEXTube verifies the channel returned by YouTube's
`channels.list(mine=true)` endpoint. The flow uses a short-lived HTTP-only state
cookie and PKCE; access tokens are never logged or returned to the browser.
OAuth verification is the required safety foundation for any future owner-only
media pipeline; it does not authorize arbitrary channels or enable media
downloading by itself.

---

## 2. Safety properties of the fetcher

Every outbound request made on an operator's behalf goes through
`src/server/import/safe-fetch.ts`, which enforces:

- **HTTPS only**, port 443 only, and no credentials in the URL.
- **A host allowlist** per connector (`youtube.com`/`.youtube.com`,
  `.googleapis.com`). DEXTube has no "fetch this arbitrary URL" entry point.
- **No private address space.** Every DNS answer is resolved before connecting and
  rejected if it is loopback, private, link-local (including the cloud metadata
  endpoint `169.254.169.254`), CGNAT, multicast, documentation or otherwise
  reserved — for IPv4 *and* IPv6, including IPv4-mapped IPv6.
- **Manual redirects**, each hop revalidated, with the chain capped.
- **A timeout and a byte ceiling**, enforced while reading the body, so a slow or
  endless response cannot pin a worker.

Honest limitation: DNS is resolved once and Node re-resolves when it connects, so
a hostile authoritative server could in principle answer differently on the second
lookup. Pinning the connect address needs a custom agent; the allowlist means the
only reachable hosts are the ones the operator already trusts, and the
private-range check makes a rebind fail closed for the common case. This is
documented rather than hidden.

Imported text is sanitised once, at the boundary (`src/server/import/sanitize.ts`):
control and bidi-override characters are stripped, whitespace collapsed, lengths
capped, and a URL is kept only if it is `https:` on a trusted host. Storage keys
are generated by DEXTube and never derived from imported text.

---

## 3. Running an import

Admin UI: **Administration → Import** (`/admin/import`). All endpoints are
administrator-only (`requireAdmin`), same-origin, rate-limited, and audited.

1. **Preview.** Resolve the address and list the entries with their real titles,
   dates, durations and thumbnails, plus the connector's limitations and the
   entry count. A preview writes nothing.
2. **Create and run.** The source is stored with the operator's stated
   authorization basis and a scope limit. If "media is authorized" is ticked, the
   basis must be a real sentence — not `x` — or the request is refused.
3. **Process.** Items are handled with bounded concurrency
   (`IMPORT_MAX_CONCURRENCY`), retried up to three attempts, and re-checked
   between items against the cancellation flag. **Runs are resumable**: re-running
   a finished or cancelled source processes only what is still `PENDING`, and a
   unique `(sourceId, dedupeKey)` index makes a repeated import incapable of
   duplicating an entry.
4. **Deduplicate.** `dedupeKey` is `<kind>:<externalId>`. An entry already
   imported by another source is recorded as `SKIPPED_DUPLICATE` rather than
   copied again.
5. **Quota.** Media copies are refused once the instance's imported bytes would
   exceed `STORAGE_QUOTA_BYTES`. It is a coarse instance-wide ceiling, not a
   per-source allocation.
6. **Clean up.** Deleting a source removes the source and its items; the videos it
   created are **kept** unless the operator explicitly opts in to deleting them,
   which is the documented path for clearing confirmed test assets.

Every step writes to `admin_audit_logs` (`import.source.create`,
`import.source.run`, `import.item.media_imported`, `import.source.complete`,
`import.source.cancel`, `import.source.retry`, `import.source.delete`). Secret-shaped
keys are redacted before an audit row is written.

### Status vocabulary

| Status | Meaning |
| --- | --- |
| `PENDING` | Not processed yet. Re-running the source will pick it up. |
| `IMPORTING` | Currently being handled. |
| `METADATA_ONLY` | Metadata stored; no media was copied, and **no `Video` row exists**. |
| `IMPORTED` | Authorized media was copied and a real `Video` was created. |
| `SKIPPED_DUPLICATE` | An equivalent entry was already imported. |
| `FAILED` | Attempts were exhausted; `lastError` states why. |

---

## 4. The isolated ten-entry test

`npm run isolated:metadata-test` exercises the whole workflow against the real
**MrBeast** channel (id `UCX6OQ3DkcsbYNE6H8uQQuVA`) inside the isolated test
environment, and refuses to run anywhere else. It:

1. resolves the channel and **refuses to continue unless the resolved channel id
   is the expected official one**, so a lookalike cannot be substituted;
2. prints the ten most recent public entries with their real ids, titles,
   publication dates, durations, thumbnail references and descriptions;
3. writes a preview/import report to `storage/isolated-test/reports/` **before**
   importing anything;
4. runs the real import service over all ten entries;
5. verifies with database queries that all ten are `METADATA_ONLY`, that **zero**
   media was imported, and that **no `Video` row was fabricated**.

**No media is imported by this test, and that is the finding rather than a
caveat.** DEXTube holds no permission to copy that creator's videos, so it stores
the metadata that YouTube publishes deliberately — with the creator's attribution
intact — and nothing else. It does not simulate a download, does not write a
placeholder file, and does not invent a track, subtitle or rendition.

```bash
npm run isolated:setup
npm run isolated:seed               # optional
npm run isolated:metadata-test
npm run isolated:metadata-test -- --replace    # clean up a previous run, then run again
npm run isolated:metadata-test -- --cleanup    # remove just this test's rows
npm run isolated:reset                         # clear the whole isolated environment
```

Add-your-own: pass `--channel <url>` to run the same test against another
channel. Fixtures created by the seeder are clearly marked as synthesised; the
metadata test stores only what the provider published, and tags its rows so
`--cleanup` removes exactly them.

---

## 5. Extending the connector interface

Adding an authorized provider (an official API, a licensed catalogue, a
rights-holder feed) means implementing `MetadataConnector` — and `MediaResolver`
if it may supply bytes — in a new module under `src/server/import/`, and adding
one line to `src/server/import/index.ts`. The service, the routes, the audit
trail and the admin UI are provider-agnostic: none of them imports a specific
connector.
