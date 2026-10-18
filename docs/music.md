# DEX Music: rights, and why the library is empty by default

DEXTube is self-hostable, and that creates a temptation: ship an audio player
with a bundled catalogue so the feature looks finished on first run. DEXTube does
not do that. Redistributing music is a licensing act, not a UI decision, so the
audio surface is built around **stored rights metadata** and starts empty.

## 1. The rule

> A track exists in DEXTube only together with a statement of where it came from,
> what licence it is under, who must be credited, where it may be distributed,
> and whether a copy may be downloaded.

If those five things are not known, the track is not added. There is no
"unknown licence" state, because "unknown" is the same as "no permission".

## 2. The data model

`Track` is owned by a channel exactly like a video (`channelId`, `uploaderId`,
`visibility`, `publishedAt`, `deletedAt`, `audioKey`). Its terms live in a
separate 1:1 `TrackRights` row:

| Field | Meaning |
| --- | --- |
| `source` | Where the audio came from, in plain words ("FFmpeg `sine` filter, DEXTube's own generator") |
| `license` | An SPDX identifier or short licence text (`CC0-1.0`, `CC-BY-4.0`, or a stated bespoke term) |
| `attribution` | The exact credit line the interface displays verbatim |
| `territory` | Where distribution is permitted ("Worldwide", or a restriction) |
| `downloadAllowed` | Whether a copy may be downloaded at all |

**Why rights are a separate table rather than columns on `Track`.** The terms
belong to the *recording*, not to the row that happens to stream it. A track can
be re-cleared, re-licensed or replaced by a differently-licensed master, and
rights are the natural place to record an expiry or a per-territory variant
later. Keeping them separate also makes the enforcement point obvious: nothing
plays or downloads without reading this row.

## 3. Where the rules are enforced

Rights metadata that only appears in the UI is decoration. The enforcement points
are:

1. **`authorizeTrackDownload()`** (`src/server/services/music.ts`) — the only way
   a download is authorised. It resolves the track, applies the visibility rules
   first (a private track is a `notFound`, so its existence is not confirmed),
   and only then checks `downloadAllowed`. A refusal is a `403` with a message
   naming the licence as the reason.
2. **The media route** (`src/app/api/media/[...path]/route.ts`) — the single
   place audio bytes are served. A `?download=1` request for a `tracks/...` key
   calls the service above, so the rights check cannot be bypassed by requesting
   the file directly. Streaming and downloading are treated as different rights:
   a streaming-only track returns `206` for playback and `403` for
   `?download=1`.
3. **The track page** — renders a download control **only** when the licence
   permits one. Otherwise it states the reason in words. There is no disabled
   button, because a disabled button still advertises a capability that does not
   exist.
4. **The library** (`listTracks`) — returns PUBLIC, non-deleted tracks only; a
   private track is not listed and is refused to anonymous viewers (`404`).

## 4. The fixtures are synthetic, and labelled as such

The seeding used for development generates its own audio — no third-party file is
downloaded, bundled or redistributed. `scripts/make-test-audio.ts`
(`npm run make:testaudio`) synthesises tones with FFmpeg's `sine` and `anoisesrc`
filters. Audio is **AAC in MP4** because stock Fedora's `ffmpeg-free` build has
no MP3 encoder — a practical constraint, recorded rather than worked around by
adding a codec.

Three tracks are seeded, each with metadata that is true:

| Track | Licence | Download | Note |
| --- | --- | --- | --- |
| Concert A (440 Hz) — reference tone | `CC0-1.0` | allowed | A computer-generated tone; CC0 is an honest fit |
| Calibration noise (white, 2 s) | `CC0-1.0` | allowed | Generated noise, private by default |
| Middle C (261.63 Hz) — streaming only | DEXTube demonstration licence — streaming only | **refused** | Exists to exercise the refusal path end to end |

The middle track is deliberately restricted: it is the fixture that proves a
streaming-only licence streams and cannot be downloaded. If it were also
downloadable, the refusal path would be untested.

## 5. What an operator must do before adding real music

1. **Hold the rights, or be inside the licence.** Public domain, CC0, a
   permissive licence you comply with, your own recording, or a licence you
   bought. "It was free to stream" is not a download right, and "it is on the
   internet" is not a licence.
2. **Record the five fields truthfully**, including the territory. A licence that
   permits distribution somewhere but not everywhere must say so.
3. **Set `downloadAllowed` from the licence, not from convenience.** `false`
   unless the licence grants redistribution.
4. **Keep the attribution line exactly as the licensor requires** — DEXTube
   displays `attribution` verbatim and does not paraphrase it.

## 6. Honest limitations

* **There is no audio upload form.** None exists, so none is shown; the empty
  state explains what a rights-cleared track requires instead of rendering a
  dead control.
* **There is no audio transcoding or ladder.** A track is stored as uploaded
  (here: one AAC/MP4 file). Quality switching, where it exists at all, is a video
  feature.
* **There is no DRM and no paywall.** Downloads are gated on the licence's
  permission, and nothing else. DEXTube cannot enforce a licence it was not told
  about, which is why the empty state is the default rather than a sample
  catalogue.
* **`downloadAllowed` is a permission, not a promise.** DEXTube will refuse a
  download; it cannot prevent a determined viewer from capturing audio that it
  streams. That is true of every streaming service, and pretending otherwise
  would be dishonest. The metadata exists so the *intent* is explicit and
  enforced where it can be.
