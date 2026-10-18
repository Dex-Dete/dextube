#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - stop the application processes started by scripts/start.sh
#
# WHAT IT DOES
#   * Reads storage/run/*.pid, verifies each process still belongs to DEXTube
#     (its working directory is the project root, or its command line mentions
#     it) before touching it, then terminates it gracefully with SIGTERM and,
#     after a timeout, with SIGKILL.
#   * Because start.sh launches each service as a session leader, the whole
#     child tree (npm -> node -> next) is signalled together via its process
#     group.
#   * Removes the PID files it consumed.
#   * Does NOT touch the database unless --with-db is given.
#
# It will never kill a process it did not start: an unverified PID is reported
# and its (stale) PID file is removed WITHOUT signalling anything.
#
# USAGE
#   bash scripts/stop.sh              # stop the app and worker
#   bash scripts/stop.sh --with-db    # also stop the PostgreSQL container
#   bash scripts/stop.sh --help
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DIR="$ROOT_DIR/storage/run"
GRACE_SECONDS="${DEXTUBE_STOP_GRACE_SECONDS:-15}"
WITH_DB=false

# ------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  _reset=$'\033[0m'; _red=$'\033[31m'; _grn=$'\033[32m'; _yel=$'\033[33m'; _blu=$'\033[34m'
else
  _reset=''; _red=''; _grn=''; _yel=''; _blu=''
fi
say()  { printf '%s %s\n' "${_blu}[stop]${_reset}" "$*"; }
ok()   { printf '%s %s\n' "${_grn}[ ok ]${_reset}" "$*"; }
warn() { printf '%s %s\n' "${_yel}[warn]${_reset}" "$*" >&2; }

usage() {
  cat <<'EOF'
DEXTube - stop the application processes started by scripts/start.sh

Usage:
  bash scripts/stop.sh [--with-db] [--help]

  --with-db   also stop the PostgreSQL container (calls scripts/db-down.sh).
              Data is always preserved. Without this flag the database keeps
              running.

Environment:
  DEXTUBE_STOP_GRACE_SECONDS   seconds to wait after SIGTERM before SIGKILL
                               (default 15)
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --with-db) WITH_DB=true ;;
    "") ;;
    *) warn "Unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- helpers --
process_belongs_to_dextube() {
  local pid="$1" cwd cmd
  [[ -d "/proc/$pid" ]] || return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$ROOT_DIR" ]] && return 0
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"$ROOT_DIR"* ]] && return 0
  return 1
}

stop_service() {
  local name="$1"
  local pidfile="$RUN_DIR/$name.pid"

  if [[ ! -f "$pidfile" ]]; then
    say "$name: no PID file (not started by scripts/start.sh) — nothing to do."
    return 0
  fi

  local pid
  pid="$(cut -d' ' -f1 < "$pidfile" 2>/dev/null || true)"

  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    warn "$name: PID file is malformed — removing it without signalling anything."
    rm -f "$pidfile"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    say "$name: pid $pid is not running — removing stale PID file."
    rm -f "$pidfile"
    return 0
  fi

  if ! process_belongs_to_dextube "$pid"; then
    warn "$name: pid $pid does not belong to DEXTube (cwd/cmdline mismatch) — refusing to kill it."
    warn "      Removing the stale PID file only."
    rm -f "$pidfile"
    return 0
  fi

  # Determine the process group. start.sh made each service a session leader,
  # so pgid == pid and the whole tree can be signalled together.
  local my_pgid target_pgid
  my_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  target_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  local group=""
  if [[ -n "$target_pgid" && "$target_pgid" != "$my_pgid" && "$target_pgid" == "$pid" ]]; then
    group="$target_pgid"
  fi

  signal_tree() {
    local sig="$1"
    if [[ -n "$group" ]]; then
      kill "-$sig" -- "-$group" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
    else
      kill "-$sig" "$pid" 2>/dev/null || true
    fi
  }

  say "$name: stopping pid $pid (SIGTERM)..."
  signal_tree TERM

  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < GRACE_SECONDS )); do
    sleep 1
    (( waited++ )) || true
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "$name: still alive after ${GRACE_SECONDS}s — sending SIGKILL."
    signal_tree KILL
    sleep 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    warn "$name: pid $pid could not be stopped."
  else
    ok "$name stopped."
  fi
  rm -f "$pidfile"
}

# ================================================================= run ======
say "Stopping DEXTube services started by scripts/start.sh"
stop_service app
stop_service worker

if [[ "$WITH_DB" == true ]]; then
  say "--with-db given: stopping the database."
  bash "$ROOT_DIR/scripts/db-down.sh"
else
  say "Database left running (use --with-db to stop PostgreSQL too)."
fi

ok "Done."
