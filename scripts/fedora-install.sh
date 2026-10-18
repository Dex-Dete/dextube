#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - Fedora installer / first-run bootstrap (idempotent)
#
# WHAT IT DOES
#   1. Detects the distribution (Fedora expected, other distros warned).
#   2. Reports whether Node.js >= 22 and npm are present, and prints the exact
#      `dnf` command to run if they are not (it never runs sudo itself).
#   3. Reports whether ffmpeg/ffprobe are present, inspects the FFmpeg build for
#      an H.264 encoder (libx264 / libopenh264) and explains the Fedora
#      ffmpeg-free situation with concrete remediation options.
#   4. Warns when Docker is missing (scripts/db-up.sh needs it).
#   5. Copies .env.example to .env when .env does not exist yet.
#   6. Installs JS dependencies (`npm ci`, falling back to `npm install`) and
#      generates the Prisma client (`npx prisma generate`).
#   7. Prints the exact next commands to run.
#
# It is safe to re-run: every step is a no-op when it is already satisfied.
# It does NOT run sudo, start services, or mutate anything outside the project.
#
# USAGE
#   bash scripts/fedora-install.sh
#   bash scripts/fedora-install.sh --help
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  _reset=$'\033[0m'; _bold=$'\033[1m'
  _red=$'\033[31m'; _grn=$'\033[32m'; _yel=$'\033[33m'; _blu=$'\033[34m'
else
  _reset=''; _bold=''; _red=''; _grn=''; _yel=''; _blu=''
fi

say()  { printf '%s %s\n' "${_blu}[dextube]${_reset}" "$*"; }
step() { printf '\n%s\n' "${_bold}==> $*${_reset}"; }
ok()   { printf '%s %s\n' "${_grn}[ ok ]${_reset}" "$*"; }
warn() { printf '%s %s\n' "${_yel}[warn]${_reset}" "$*" >&2; }
die()  { printf '%s %s\n' "${_red}[fail]${_reset}" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
DEXTube - Fedora installer / first-run bootstrap (idempotent)

Checks Node.js >= 22, npm, ffmpeg/ffprobe (and its H.264 encoders), and Docker;
copies .env.example to .env when needed; installs dependencies and generates the
Prisma client. It never runs sudo and is safe to re-run.

Usage:
  bash scripts/fedora-install.sh
  bash scripts/fedora-install.sh --help
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) die "Unknown argument: $1 (try --help)" ;;
esac

# ============================================================== 1. distro ===
step "Detecting distribution"
distro_id=""
distro_like=""
distro_pretty="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  distro_id="${ID:-}"
  distro_like="${ID_LIKE:-}"
  distro_pretty="${PRETTY_NAME:-${NAME:-unknown}}"
fi

if [[ "$distro_id" == "fedora" || "$distro_like" == *fedora* ]]; then
  ok "Fedora detected: ${distro_pretty}"
elif [[ -n "$distro_id" ]]; then
  warn "This looks like '${distro_pretty}', not Fedora."
  warn "DEXTube targets Fedora. The steps below use dnf; adapt them for your distro"
  warn "(e.g. apt/pacman). Continuing anyway — nothing here is Fedora-exclusive except the package names."
else
  warn "Could not read /etc/os-release; assuming a non-Fedora system. Continuing."
fi

# ================================================================ 2. Node ===
step "Checking Node.js and npm"
node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"

if [[ -n "$node_bin" ]]; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  node_full="$(node --version 2>/dev/null || echo "?")"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )); then
    ok "Node.js ${node_full} (>= 22)"
  else
    warn "Node.js ${node_full} is too old — DEXTube requires Node.js >= 22."
    warn "Install a newer Node.js with:"
    warn "    sudo dnf install nodejs npm"
  fi
else
  warn "Node.js was not found."
  warn "Install it with:"
  warn "    sudo dnf install nodejs npm"
fi

if [[ -n "$npm_bin" ]]; then
  ok "npm $(npm --version 2>/dev/null || echo '?')"
else
  warn "npm was not found. It ships with the Fedora 'npm' package:"
  warn "    sudo dnf install npm"
fi

if [[ -z "$node_bin" || -z "$npm_bin" ]]; then
  die "Install Node.js >= 22 and npm (see the commands above), then re-run this script."
fi

# ============================================================== 3. FFmpeg ===
step "Checking FFmpeg (video processing)"
have_ffmpeg=false
have_ffprobe=false
command -v ffmpeg  >/dev/null 2>&1 && have_ffmpeg=true
command -v ffprobe >/dev/null 2>&1 && have_ffprobe=true

if [[ "$have_ffmpeg" == true && "$have_ffprobe" == true ]]; then
  ok "ffmpeg and ffprobe are installed."
else
  [[ "$have_ffmpeg"  == true ]] || warn "ffmpeg not found."
  [[ "$have_ffprobe" == true ]] || warn "ffprobe not found."
  warn "Install both with:"
  warn "    sudo dnf install ffmpeg-free"
  warn "(ffmpeg-free provides the ffmpeg and ffprobe binaries. It is the Fedora-legal"
  warn " build — see the encoder note below.)"
fi

if [[ "$have_ffmpeg" == true ]]; then
  encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  has_x264=false
  has_openh264=false
  has_nvenc=false
  has_vaapi=false
  grep -qw 'libx264'      <<<"$encoders" && has_x264=true
  grep -qw 'libopenh264'  <<<"$encoders" && has_openh264=true
  grep -qw 'h264_nvenc'   <<<"$encoders" && has_nvenc=true
  grep -qw 'h264_vaapi'   <<<"$encoders" && has_vaapi=true

  if [[ "$has_x264" == true ]]; then
    ok "FFmpeg provides libx264 (full build, typically RPM Fusion) — best quality/size."
  elif [[ "$has_openh264" == true ]]; then
    ok "FFmpeg provides libopenh264 (Cisco OpenH264) — DEXTube will use this."
  else
    warn "No H.264 encoder (libx264, libopenh264, h264_nvenc, h264_vaapi) was found."
  fi
  [[ "$has_nvenc" == true ]] && say "  also available: h264_nvenc (NVIDIA hardware, used if a GPU node is visible)"
  [[ "$has_vaapi" == true ]] && say "  also available: h264_vaapi (Intel/AMD hardware, used if a render node initialises)"

  if [[ "$has_x264" == false ]]; then
    printf '\n'
    warn "── Fedora FFmpeg note ──────────────────────────────────────────────"
    warn "Fedora ships 'ffmpeg-free', which deliberately omits the"
    warn "patent-encumbered libx264 encoder. A stock install therefore has no"
    warn "libx264 and a naive pipeline would fail with: Unknown encoder 'libx264'."
    warn ""
    warn "DEXTube does NOT hardcode libx264. It negotiates, in order:"
    warn "    libx264 -> h264_nvenc -> h264_vaapi -> libopenh264"
    warn "and you may force one with VIDEO_ENCODER=... in .env."
    warn ""
    if [[ "$has_openh264" == true ]]; then
      warn "Your build has libopenh264, so transcoding already works (video is"
      warn "driven by a target bitrate instead of CRF). Nothing more is required."
      warn "For better quality-per-byte, install RPM Fusion's ffmpeg (below)."
    else
      warn "Your build has NO usable H.264 encoder. Pick ONE option:"
    fi
    warn ""
    warn "Option A — stay on Fedora's free stack and enable OpenH264:"
    warn "    sudo dnf config-manager setopt fedora-cisco-openh264.enabled=1"
    warn "    sudo dnf install ffmpeg-free"
    warn ""
    warn "Option B — install RPM Fusion's full FFmpeg (provides libx264):"
    warn "    sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-\$(rpm -E %fedora).noarch.rpm"
    warn "    sudo dnf install ffmpeg"
    warn "    # if ffmpeg-free is already installed, RPM Fusion's build replaces it:"
    warn "    sudo dnf swap ffmpeg-free ffmpeg --allowerasing"
    warn "────────────────────────────────────────────────────────────────────"
    printf '\n'
  fi
fi

# ============================================================== 4. Docker ===
step "Checking Docker (for the local PostgreSQL container)"
if command -v docker >/dev/null 2>&1; then
  ok "docker is installed ($(docker --version 2>/dev/null || echo 'version unknown'))."
  if docker info >/dev/null 2>&1; then
    ok "the Docker daemon is reachable."
  else
    warn "the Docker daemon is not reachable as this user."
    warn "Start/enable it and join the docker group (then log out and back in):"
    warn "    sudo systemctl enable --now docker"
    warn "    sudo usermod -aG docker \$USER"
  fi
else
  warn "Docker was not found. scripts/db-up.sh needs it (or an external PostgreSQL)."
  warn "Install one of:"
  warn "    sudo dnf install moby-engine docker-compose   # Fedora's packages"
  warn "    sudo systemctl enable --now docker"
  warn "    sudo usermod -aG docker \$USER                 # then log out and back in"
  warn "Alternatively point DATABASE_URL at an existing PostgreSQL 16 and skip Docker."
fi

# =============================================================== 5. .env ===
step "Preparing environment file"
if [[ -f .env ]]; then
  ok ".env already exists — leaving it untouched."
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    ok "created .env from .env.example"
    warn "You MUST edit .env and set at least POSTGRES_PASSWORD and SESSION_SECRET."
    warn "    SESSION_SECRET: openssl rand -base64 48"
    if grep -q '^POSTGRES_PASSWORD=CHANGE_ME' .env; then
      warn "POSTGRES_PASSWORD is still the placeholder 'CHANGE_ME'."
    fi
    if grep -q '^SESSION_SECRET=CHANGE_ME' .env; then
      warn "SESSION_SECRET is still the placeholder; the app will refuse to start."
    fi
  else
    die ".env.example is missing; cannot create .env. Is this the DEXTube repo root?"
  fi
fi

# =========================================================== 6. install ===
step "Installing JavaScript dependencies"
if [[ -f package-lock.json ]]; then
  if npm ci; then
    ok "dependencies installed with 'npm ci'."
  else
    warn "'npm ci' failed (often a stale/absent lockfile). Falling back to 'npm install'."
    npm install
    ok "dependencies installed with 'npm install'."
  fi
else
  warn "package-lock.json not found; running 'npm install'."
  npm install
  ok "dependencies installed."
fi

step "Generating the Prisma client"
npx prisma generate
ok "Prisma client generated."

# ============================================================== 7. next ===
step "Setup complete — next steps"
cat <<EOF

  1. Edit .env and set real secrets:
       POSTGRES_PASSWORD   (matches docker-compose / scripts/db-up.sh)
       SESSION_SECRET      (openssl rand -base64 48)
       DATABASE_URL        (postgresql://dextube:<password>@localhost:5433/dextube)

  2. Start DEXTube (development):
       bash scripts/start.sh

     Start DEXTube (production):
       bash scripts/start.sh --prod

  3. Or do it step by step:
       bash scripts/db-up.sh
       npx prisma migrate deploy
       npm run doctor
       npm run dev

  4. Verify the install any time with:
       npm run doctor

  5. Stop the app (and optionally the database):
       bash scripts/stop.sh
       bash scripts/stop.sh --with-db

  Documentation: docs/fedora.md

EOF
