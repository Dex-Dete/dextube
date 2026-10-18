# DEXTube Dependencies and Licensing

This document catalogues DEXTube's direct dependencies, their licenses, and what
each is used for — plus the external system dependencies and how they interact
with DEXTube's own license (**AGPL-3.0-or-later**).

Versions below are taken from [`package.json`](../package.json). Versions are
pinned exactly, and `package-lock.json` pins the full **transitive** tree, so
`npm ci` reproduces an identical install. (A full transitive SBOM would be
generated from the lockfile with a tool such as `npm sbom`; this page covers the
direct dependencies plus the system tools DEXTube invokes.)

---

## 1. Runtime dependencies

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| `@node-rs/argon2` | `2.2.2` | MIT | Argon2id password hashing and verification. Ships a prebuilt native binary, so no C toolchain is required at install time. |
| `@prisma/client` | `6.19.3` | Apache-2.0 | Typed database client generated from `prisma/schema.prisma`. |
| `clsx` | `2.1.1` | MIT | Conditional `className` composition. Declared as a dependency; not currently imported anywhere under `src/**`. |
| `jose` | `6.2.12` | MIT | JOSE/JWT/JWS utilities. Declared as a dependency; not currently imported anywhere under `src/**` (DEXTube uses opaque hashed session tokens, not JWTs). |
| `next` | `16.4.2` | MIT | The web framework: App Router, React Server Components, route handlers, and the server that runs the production build. |
| `react` | `19.3.1` | MIT | UI library. |
| `react-dom` | `19.3.1` | MIT | React DOM renderer. |
| `server-only` | `^0.0.1` | MIT | Marks server-only modules so they cannot be bundled into client code. The only dependency declared with a caret range. |
| `zod` | `4.6.7` | MIT | Runtime schema validation for every request body, query parameter, and configuration value. |

## 2. Development dependencies

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| `@playwright/test` | `1.64.1` | Apache-2.0 | End-to-end browser tests (`npm run test:e2e`). |
| `@tailwindcss/postcss` | `4.3.3` | MIT | Tailwind CSS v4 PostCSS integration. |
| `@types/node` | `22.19.4` | MIT | Node.js type definitions. |
| `@types/react` | `19.3.0` | MIT | React type definitions. |
| `@types/react-dom` | `19.3.0` | MIT | React DOM type definitions. |
| `eslint` | `9.x` | MIT | Linter (`npm run lint`) via the ESLint CLI; Next.js 16 removed `next lint`. |
| `eslint-config-next` | `16.4.2` | MIT | Next.js/React/TypeScript lint rule-sets consumed by `eslint.config.mjs`. |
| `prisma` | `6.19.3` | Apache-2.0 | Prisma CLI: migrations, client generation, and Studio. |
| `tailwindcss` | `4.3.3` | MIT | Utility-first CSS framework (the DEXTube design tokens live in CSS variables). |
| `tsx` | `4.20.6` | MIT | TypeScript runner used for the background worker (`npm run worker`), scripts, and the seed. |
| `typescript` | `5.9.3` | Apache-2.0 | Type checking (`npm run typecheck`) and compilation. |
| `vitest` | `3.2.7` | MIT | Unit and integration test runner (`npm test`). |

---

## 3. License compatibility with AGPL-3.0-or-later

DEXTube is licensed **AGPL-3.0-or-later**. Every direct dependency is under
either **MIT** or **Apache-2.0**, both of which are permissive and are compatible
with combining into an AGPL-3.0-licensed work:

- **MIT** is a permissive license compatible with the GPL/AGPL family
  (a permissive work may be distributed as part of a larger AGPL work).
- **Apache-2.0** is compatible with GPLv3 and AGPLv3 (the Free Software
  Foundation considers Apache-2.0 compatible with GPLv3). Apache-2.0's patent
  grant and NOTICE requirements should be preserved.

**Obligations that remain:**

- Redistributing DEXTube (including as a network service, per the AGPL) must keep
  the corresponding source available under AGPL-3.0-or-later.
- You must preserve the copyright notices and license texts of MIT- and
  Apache-2.0-licensed dependencies you redistribute.
- If you **add** a dependency, verify its license is AGPL-3.0-or-later compatible
  before merging and call it out in your pull request (see
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) §14).

No dependency in this list carries a copyleft license that would conflict with
AGPL-3.0-or-later. (A future addition under a non-compatible license would be a
blocker, not a footnote.)

---

## 4. Original assets and no YouTube material

DEXTube contains **no YouTube proprietary code, assets, or trademarks**:

- The **icon set** is original (`src/components/icons.tsx`), drawn as SVG
  components for DEXTube.
- The **visual identity** (branding, colours, design tokens, themes) is original
  and defined in `src/app/globals.css` and the component system.
- **No binary image assets** are committed to the repository. Screenshots are a
  documented placeholder in the [`README`](../README.md#screenshots) for this
  reason.
- **Test media is synthesised.** `npm run make:testmedia`
  (`scripts/make-test-media.ts`) generates patterns with FFmpeg's `testsrc2`
  source and a sine tone. There is no third-party media anywhere in the repository
  or the test fixtures.
- The name "DEXTube" and the project's branding are its own; no third-party
  product's marks are used to identify it.

---

## 5. External system dependencies

These are **not** JavaScript packages; they are programs the operator installs.

### 5.1 FFmpeg and FFprobe (required for video processing)

- **What DEXTube uses:** `ffprobe` for metadata extraction and `ffmpeg` for
  thumbnails, posters, remuxing, transcoding, and optional HLS packaging.
- **How they are invoked:** as **external executables** via `child_process.spawn`
  with an argument array and no shell (`src/server/media/exec.ts`). DEXTube does
  **not link** FFmpeg's libraries into the application. Because FFmpeg is a
  separate program invoked over its command-line interface, its license governs
  FFmpeg itself, not DEXTube's source code. **The operator is responsible for
  complying with the license of whichever FFmpeg build they install** (and with
  any patent considerations in their jurisdiction).
- **License of FFmpeg:** the FFmpeg project is licensed under the **LGPL-2.1-or-later**
  by default, but a build that enables GPL-only components is licensed under the
  **GPL**. Enabling **`libx264`** is the common reason a build becomes GPL, since
  x264 is GPL-2.0-or-later. `libopenh264` (Cisco OpenH264) is BSD-2-Clause, and
  Cisco provides the corresponding-binary distribution terms via its own
  repository.
- **Fedora `ffmpeg-free` vs RPM Fusion:**

  | Source | Provides | DEXTube behaviour |
  | --- | --- | --- |
  | Fedora's `ffmpeg-free` (`sudo dnf install ffmpeg-free`) | `ffmpeg`, `ffprobe`, and `libopenh264` (via the Cisco openh264 repo) but **not** `libx264` | DEXTube negotiates and uses `libopenh264` (software H.264, bitrate-driven). |
  | RPM Fusion's `ffmpeg` (`sudo dnf install ffmpeg`, replacing `ffmpeg-free`) | A full build including **`libx264`** (GPL) | DEXTube picks `libx264` automatically (better quality per byte, CRF control). |

  DEXTube never hardcodes an encoder; it inspects `ffmpeg -encoders` at runtime
  and negotiates one (`libx264` → `h264_nvenc` → `h264_vaapi` → `libopenh264`),
  overridable with `VIDEO_ENCODER`. See
  [`docs/fedora.md`](./fedora.md#13-ffmpeg-and-the-encoder-story-read-this) and
  [`docs/architecture.md`](./architecture.md#runtime-h264-encoder-negotiation).

- **Hardware encoders:** `h264_nvenc` (NVIDIA) and `h264_vaapi` (Intel/AMD) are
  part of the FFmpeg build and are used only when a device is actually available
  and initialises.

### 5.2 Other system dependencies

| Component | Version used | License | Purpose |
| --- | --- | --- | --- |
| Node.js | >= 22 (`engines` in `package.json`) | MIT-style (Node.js license) | Runtime for the web app, the worker, and the scripts. |
| PostgreSQL | 16 (Docker `postgres:16-alpine` or native) | PostgreSQL License (BSD-like) | Primary datastore. The `pg_trgm` extension is bundled with PostgreSQL. |
| Docker / Podman | optional | Apache-2.0 | Only needed for the default containerised development database (`scripts/db-up.sh`). An external PostgreSQL 16 removes this requirement. |

---

## 6. Supply-chain and secret handling

- **Exact versions + lockfile.** Direct versions are pinned exactly in
  `package.json` and the entire tree is pinned in `package-lock.json`; use
  `npm ci` for reproducible installs.
- **Small surface.** DEXTube deliberately bundles no AWS SDK and no heavyweight
  mail library; the SMTP client is a small, auditable subset implemented in
  `src/server/email.ts`.
- **No secrets in the repository.** `.env` is git-ignored; only `.env.example`
  with placeholders is committed. Production configuration is validated at
  startup and refuses placeholder secrets.
- **No secrets in logs.** Production logging is structured and does not emit
  session tokens or credentials.
- Run `npm audit` (or your preferred scanner) against the lockfile as part of
  your release process; vulnerabilities that are already public and fixed
  upstream should be raised upstream as well.
- **Known advisories (development-only).** At the time of writing, `npm audit`
  reports 11 advisories (1 moderate, 8 high, 2 critical) inside the **ESLint
  toolchain's transitive dependencies** pulled in by `eslint-config-next`. They
  are development-time only: nothing from that tree is bundled into the app or
  shipped to a server. They have deliberately not been force-fixed, because
  `npm audit fix --force` would move `eslint-config-next` outside its pinned
  Next.js version. Re-audit on the next release and bump when upstream supports
  it.
