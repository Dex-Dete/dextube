#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - restore a backup created by scripts/backup.sh
#
# WHAT IT DOES
#   * Requires an explicit --yes flag; without it nothing is touched.
#   * Verifies manifest.txt exists and that database.sql.gz and media.tar.gz
#     exist and are non-empty BEFORE destroying anything.
#   * Restores the database (drops and recreates the public schema, then loads
#     the dump) using `docker exec` against the running container, or the host
#     `psql` with DATABASE_URL when the container is absent.
#   * Replaces MEDIA_ROOT with the media archive, moving the current media
#     directory aside as <media-root>.pre-restore-<stamp> so the change is
#     reversible.
#
#   THIS REPLACES YOUR CURRENT DATABASE DATA. There is no undo beyond your own
#   backup. It never runs without --yes.
#
# USAGE
#   bash scripts/restore.sh <backup-dir> --yes
#   bash scripts/restore.sh --help
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="dextube-postgres"

# ------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  _reset=$'\033[0m'; _bold=$'\033[1m'
  _red=$'\033[31m'; _grn=$'\033[32m'; _yel=$'\033[33m'; _blu=$'\033[34m'
else
  _reset=''; _bold=''; _red=''; _grn=''; _yel=''; _blu=''
fi
say()  { printf '%s %s\n' "${_blu}[restore]${_reset}" "$*"; }
ok()   { printf '%s %s\n' "${_grn}[ ok ]${_reset}" "$*"; }
warn() { printf '%s %s\n' "${_yel}[warn]${_reset}" "$*" >&2; }
die()  { printf '%s %s\n' "${_red}[fail]${_reset}" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
DEXTube - restore a backup produced by scripts/backup.sh

Usage:
  bash scripts/restore.sh <backup-dir> --yes
  bash scripts/restore.sh --help

  <backup-dir>   a directory containing manifest.txt, database.sql.gz and
                 media.tar.gz (as created by scripts/backup.sh).
  --yes          REQUIRED. Confirms you understand existing database data and
                 media will be replaced.

WARNING: this destroys the current database contents. Make a fresh backup
first if you are unsure: bash scripts/backup.sh
EOF
}

# ============================================================== 1. args ====
BACKUP_DIR=""
CONFIRMED=false
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --yes|-y) CONFIRMED=true ;;
    -*) die "Unknown option: $arg (try --help)" ;;
    *)
      [[ -z "$BACKUP_DIR" ]] || die "Only one backup directory argument is supported."
      BACKUP_DIR="$arg"
      ;;
  esac
done

[[ -n "$BACKUP_DIR" ]] || die "Missing <backup-dir> argument. Try --help."

if [[ "$BACKUP_DIR" != /* ]]; then
  BACKUP_DIR="$ROOT_DIR/$BACKUP_DIR"
fi
[[ -d "$BACKUP_DIR" ]] || die "Backup directory not found: $BACKUP_DIR"

if [[ "$CONFIRMED" != true ]]; then
  warn "Refusing to restore without confirmation."
  warn "Existing database data and media will be REPLACED."
  warn "Re-run with --yes when you are sure:"
  warn "    bash scripts/restore.sh \"$BACKUP_DIR\" --yes"
  exit 1
fi

# ========================================================= 2. read .env =====
env_value() {
  local key="$1" line
  line="$(grep -E "^[[:space:]]*${key}=" "$ROOT_DIR/.env" 2>/dev/null | tail -n1 || true)"
  [[ -z "$line" ]] && return 1
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

[[ -f "$ROOT_DIR/.env" ]] || die ".env not found; it is needed to locate the database and MEDIA_ROOT."

POSTGRES_USER="$(env_value POSTGRES_USER || echo dextube)"
POSTGRES_DB="$(env_value POSTGRES_DB || echo dextube)"
DATABASE_URL="$(env_value DATABASE_URL || true)"
MEDIA_ROOT="$(env_value MEDIA_ROOT || echo './storage/media')"

if [[ "$MEDIA_ROOT" == /* ]]; then
  MEDIA_ABS="$MEDIA_ROOT"
else
  MEDIA_ABS="$ROOT_DIR/${MEDIA_ROOT#./}"
fi

# ==================================================== 3. verify backup ======
say "Verifying backup contents: $BACKUP_DIR"
MANIFEST="$BACKUP_DIR/manifest.txt"
DB_DUMP="$BACKUP_DIR/database.sql.gz"
MEDIA_ARCHIVE="$BACKUP_DIR/media.tar.gz"

[[ -f "$MANIFEST" ]] || die "manifest.txt is missing — this does not look like a DEXTube backup."
[[ -s "$MANIFEST" ]] || die "manifest.txt is empty."
[[ -f "$DB_DUMP" ]] || die "database.sql.gz is missing from the backup."
[[ -s "$DB_DUMP" ]] || die "database.sql.gz is empty — refusing to restore a corrupt backup."
[[ -f "$MEDIA_ARCHIVE" ]] || die "media.tar.gz is missing from the backup."
[[ -s "$MEDIA_ARCHIVE" ]] || die "media.tar.gz is empty — refusing to restore a corrupt backup."

# Confirm the archives are readable, not just present.
gzip -t "$DB_DUMP" || die "database.sql.gz is not a valid gzip file."
tar -tzf "$MEDIA_ARCHIVE" >/dev/null 2>&1 || die "media.tar.gz is not a valid tar.gz file."
ok "manifest, database dump, and media archive are present and readable."

manifest_timestamp="$(grep -E '^timestamp:' "$MANIFEST" | head -n1 | sed -E 's/^timestamp:[[:space:]]*//' || true)"
manifest_version="$(grep -E '^version:' "$MANIFEST" | head -n1 | sed -E 's/^version:[[:space:]]*//' || true)"

# ======================================================== 4. confirmation ===
printf '\n'
warn "═══════════════════════════════════════════════════════════════════"
warn "  THIS REPLACES YOUR CURRENT DEXTube DATA."
warn "  Database : ${POSTGRES_DB}  (all tables are dropped and reloaded)"
warn "  Media    : ${MEDIA_ABS}   (current directory moved aside)"
warn "  Backup   : $BACKUP_DIR"
warn "  Taken at : ${manifest_timestamp:-unknown} (version ${manifest_version:-unknown})"
warn "═══════════════════════════════════════════════════════════════════"
printf '\n'
say "Proceeding because --yes was given."

# ================================================== 5. restore database =====
say "Restoring the database"
container_running=false
if command -v docker >/dev/null 2>&1 \
   && [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" == "true" ]]; then
  container_running=true
fi

if [[ "$container_running" == true ]]; then
  say "using docker exec $CONTAINER_NAME"
  docker exec -i "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA IF EXISTS public CASCADE;' \
    -c 'CREATE SCHEMA public;'
  gunzip -c "$DB_DUMP" | docker exec -i "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
else
  if ! command -v psql >/dev/null 2>&1; then
    die "The container '$CONTAINER_NAME' is not running and no host 'psql' is installed.
       Start the container (bash scripts/db-up.sh) or install the client tools:
           sudo dnf install postgresql"
  fi
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in .env; cannot restore with the host psql."
  say "using host psql (DATABASE_URL)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA IF EXISTS public CASCADE;' \
    -c 'CREATE SCHEMA public;'
  gunzip -c "$DB_DUMP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
fi
ok "database restored."

# ===================================================== 6. restore media =====
say "Restoring media"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ -d "$MEDIA_ABS" ]] && [[ -n "$(ls -A "$MEDIA_ABS" 2>/dev/null || true)" ]]; then
  MOVED="${MEDIA_ABS%/}.pre-restore-$STAMP"
  say "moving existing media aside: $MOVED"
  mv "$MEDIA_ABS" "$MOVED"
  ok "existing media preserved at $MOVED"
fi
mkdir -p "$MEDIA_ABS"
tar -xzf "$MEDIA_ARCHIVE" -C "$MEDIA_ABS"
ok "media extracted into $MEDIA_ABS"

# ============================================================== 7. report ==
printf '\n'
ok "Restore complete."
say "Next steps:"
say "  1. Verify:   npm run doctor"
say "  2. Start:    bash scripts/start.sh"
if [[ -n "${MOVED:-}" ]]; then
  say "  The previous media directory is kept at: $MOVED"
  say "  Delete it once you are happy with the restore."
fi
