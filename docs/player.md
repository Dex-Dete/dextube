# The DEXTube Player

DEXTube plays video with the browser's own `<video>` element and a control layer
written in this repository. This document explains what the player does, the
measurements and constraints behind that choice, and the library evaluation that
was carried out before writing it.

The implementation is `src/components/watch/VideoPlayer.tsx`, with the icons in
`src/components/watch/player-icons.tsx` and the rendition list built in
`src/app/watch/[id]/page.tsx`.

---

## 1. What the player is

* **The media element is native.** `<video>` is server-rendered with its `src`,
  so playback starts without waiting for a client bundle and works with
  JavaScript disabled up to the point of needing controls. The player removes
  `controls` and draws its own bar on top, because the native bar cannot be
  styled or extended consistently across browsers.
* **Controls**: play/pause, a seek bar, elapsed/total time, mute and volume,
  playback speed (0.25×–2×), quality, captions, picture-in-picture, fullscreen,
  and a keyboard-shortcut dialog.
* **Keyboard**: `k` or `Space` play/pause, `←`/`→` seek 5 s, `j`/`l` seek 10 s,
  `↑`/`↓` volume, `m` mute, `f` fullscreen, `.`/`,` step the speed down and up,
  `0`–`9` jump to a percentage.
* **Roles and names are real**: the seek bar is `role="slider"` with
  `aria-label="Seek"` and `aria-valuemax` set to the element's actual duration;
  the settings menus are `role="menu"` with `menuitem` / `menuitemradio`
  children; every icon button has an `aria-label`.
* **Captions** come from the video's `CAPTION` tracks. There are no generated or
  guessed captions.

## 2. Quality switching is manual, and says so

The quality menu is built from the video's stored `PROGRESSIVE` renditions —
`buildPlayerRenditions()` maps the database rows to menu entries, so the menu
cannot list a rendition that does not exist and cannot omit one that does.

* Switching swaps the `<video>` `src` and restores the playhead, then reapplies
  the playback speed.
* **The menu never says "Auto" and nothing claims to be adaptive.** DEXTube does
  not run an ABR algorithm, so advertising one would be a lie. A manual switch is
  exactly what happens.
* **With fewer than two renditions the row is not interactive**: it renders as
  `aria-disabled="true"` text reading "Single rendition", and no `menuitemradio`
  exists. A video that was never given a ladder does not pretend to offer a
  choice.
* Renditions only exist when the FFmpeg ladder ran; a passthrough upload has one
  progressive file.

## 3. Resume and progress reporting

Resume is computed from `watch_progress`, with a deliberate window:

| Constant | Value | Why |
| --- | --- | --- |
| `RESUME_MIN_SECONDS` | 5 | Anything shorter is not worth resuming |
| `RESUME_TAIL_SECONDS` | 10 | The last ten seconds are "watched", not "unfinished" |
| `RESUME_TAIL_RATIO` | 0.15 | The smaller of 10 s and 15% is used as the tail |

That ratio is what makes a short clip resumable at all: with a fixed 10-second
tail, a 10-second video could never be resumed, so the tail is capped at 15% of
the duration and a 10-second clip resumes between 5 s and 8.5 s.

Progress writes are throttled rather than sent per `timeupdate`, and the pending
value is flushed on pause and on `pagehide` with `keepalive`, so leaving the page
during playback does not lose the position.

## 4. Bugs found by driving a real browser

Two defects were only visible in a real browser against the production build,
and both are now covered by `tests/e2e/player.spec.ts`:

1. **The seek bar was pinned at `max=0`.** The `<video>` is server-rendered with
   its source, so on a fast connection the browser could finish loading metadata
   *before* React hydrated and attached listeners. The missed `loadedmetadata`
   event left the duration at 0 — the total time read `0:00` and seeking was
   impossible. The media effect now checks `readyState >= HAVE_METADATA` on mount
   and applies it, guarded by a ref so the real event does not apply it twice.
2. **A quality switch re-counted a view.** The per-source refs (`resumeApplied`,
   `metadataApplied`) are reset when `activeSrc` changes, while `viewSent` is
   reset only when `videoId` changes.

## 5. Evaluation: `@vidstack/react` (not adopted)

Before writing the control layer, the obvious candidate was evaluated.

| Question | Finding |
| --- | --- |
| Version / licence | `@vidstack/react@1.15.7`, MIT |
| Peer dependencies | `react: ^18.0.0 \|\| ^19.0.0` — compatible with this repo |
| Unpacked size | **3,312,029 bytes (≈3.16 MiB)** — `npm view @vidstack/react dist.unpackedSize` |
| What it adds over `<video>` | A provider/component architecture, a state store, UI primitives, and **HLS/DASH engines with real ABR** |

**Decision: not adopted.** The reasoning, in order of weight:

1. **The main value it sells is the thing this deployment turns off.** DEXTube
   ships progressive MP4 with HTTP range requests and runs with
   `ENABLE_HLS=false`; the HLS implementation — and with it the ABR engine that
   justifies the dependency — is disabled. Paying 3 MiB of client JavaScript and
   a new component model to not use its headline feature is a bad trade.
2. **The browser already owns the hard part.** Codec support, buffering, range
   requests, picture-in-picture and fullscreen are the platform's job. What was
   actually missing was a control surface, and that is the part that is small.
3. **Deployment size and memory matter here.** DEXTube is designed to run on a
   modest self-hosted box; the player is on the critical path for every watch
   request.
4. **The economy is deliberate.** The player has no skip-intro/outro, no
   thumbnail-sprite seek preview (a time tooltip is used instead), and no ABR
   claims. Reintroducing a library to get those features back would mean
   re-adding the complexity this design removed.

**What would change the decision:** enabling HLS (`ENABLE_HLS=true`) with a
multi-rendition ladder and a genuine desire for adaptive switching. At that point
ABR becomes real work, the HLS engine becomes the point rather than dead weight,
and a maintained player library is the right call. Until then the honest answer
is a small control layer over `<video>`.

`media-chrome` (MIT, `4.19.3`) was also considered as a lighter alternative for
the control surface alone, and rejected for the same reason: the existing layer
is small, fully keyboard-accessible and already covered by browser tests, so
swapping it for a dependency buys consistency with other sites rather than
anything this project needs.

## 6. Deliberately absent

* **Adaptive bitrate / HLS.** Off by default; no UI implies otherwise.
* **Skip intro/outro.** No markers exist to skip.
* **Thumbnail-sprite seek previews.** Would require generating and storing sprite
  sheets per video; the time tooltip is the honest minimum.
* **Captions that are not stored.** Nothing is transcribed or guessed.

## 7. Tests

`tests/e2e/player.spec.ts` (6 tests, real Chromium against the production build):

1. the native bar is gone, custom controls exist, and the element actually plays;
2. the quality menu lists this video's real renditions (`720p`/`480p`/`360p`,
   descending, no "Auto") and switching keeps the playhead and returns `206`;
3. the speed menu and the `,` / `.` keys change `playbackRate`;
4. keyboard control and mute operate on the live element;
5. resume: play past 5.5 s, wait for the progress `PUT`, reload, and the page
   offers "Resumed from", with "Start over" rewinding;
6. a single-rendition video shows non-interactive "Single rendition" text and
   exposes zero `menuitemradio`s.
