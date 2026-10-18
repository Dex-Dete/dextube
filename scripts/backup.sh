#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - back up the database AND the media directory
#
# WHAT IT DOES
#   Creates a timestamped directory containing:
#     database.sql.gz   plain-SQL pg_dump of the DEXTube database (gzipped)
#     media.tar.gz      tar.gz of MEDIA_ROOT
#     manifest.txt      timestamp, DEXTube version, database name, media root,
#                       and the size + SHA-256 of each artifact
#
#   The database is dumped with `docker exec` against the `dextube-postgres`
#   container when it is running; otherwise it falls back to the host's
#   `pg_dump` using DATABASE_URL. Which path was used is recorded in the
#   manifest.
#
#   It refuses to overwrite an existing backup directory and prints the exact
#   restore command when finished.
#
# USAGE
#   bash scripts/backup.sh                 # -> storage/backups/dextube-<stamp>/
#   bash scripts/backup.sh /mnt/backups    # -> /mnt/backups/dextube-<stamp>/
#   bash scripts/backup.sh --help
#
#   The optional argument is the *destination parent directory*; a timestamped
#   subdirectory is always created inside it so backups never collide.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="dextube-postgres"

# ------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  _reset=$'\033[0m'; _red=$'\033[31m'; _grn=$'\033[32m'; _yel=$'\033[33m'; _blu=$'\033[34m'
else
  _reset=''; _red=''; _grn=''; _yel=''; _blu=''
fi
say()  { printf '%s %s\n' "${_blu}[backup]${_reset}" "$*"; }
ok()   { printf '%s %s\n' "${_grn}[ ok ]${_reset}" "$*"; }
warn() { printf '%s %s\n' "${_yel}[warn]${_reset}" "$*" >&2; }
die()  { printf '%s %s\n' "${_red}[fail]${_reset}" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
DEXTube - back up the database and MEDIA_ROOT

Usage:
  bash scripts/backup.sh [DESTINATION_PARENT] [--help]

  DESTINATION_PARENT  where to create the timestamped backup directory
                      (default: storage/backups). Relative paths are resolved
                      against the DEXTube root.

Produces:
  database.sql.gz   gzipped plain-SQL pg_dump
  media.tar.gz      gzipped tar of MEDIA_ROOT
  manifest.txt      timestamp, version, database name, media root, checksums
EOF
}

DEST=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -*) die "Unknown option: $arg (try --help)" ;;
    *) [[ -z "$DEST" ]] || die "Only one destination argument is supported."; DEST="$arg" ;;
  esac
done

if [[ -z "$DEST" ]]; then
  DEST="$ROOT_DIR/storage/backups"
elif [[ "$DEST" != /* ]]; then
  DEST="$ROOT_DIR/$DEST"
fi

# --------------------------------------------------------- read .env values
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

[[ -f "$ROOT_DIR/.env" ]] || die ".env not found. Run scripts/fedora-install.sh or copy .env.example to .env first."

POSTGRES_USER="$(env_value POSTGRES_USER || echo dextube)"
POSTGRES_DB="$(env_value POSTGRES_DB || echo dextube)"
DATABASE_URL="$(env_value DATABASE_URL || true)"
MEDIA_ROOT="$(env_value MEDIA_ROOT || echo './storage/media')"

# Resolve MEDIA_ROOT (which may be relative) against the project root.
if [[ "$MEDIA_ROOT" == /* ]]; then
  MEDIA_ABS="$MEDIA_ROOT"
else
  MEDIA_ABS="$ROOT_DIR/${MEDIA_ROOT#./}"
fi

checksum_cmd=""
if command -v sha256sum >/dev/null 2>&1; then
  checksum_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_cmd="shasum -a 256"
fi

checksum_of() {
  local file="$1"
  if [[ -z "$checksum_cmd" ]]; then
    printf 'unavailable'
    return 0
  fi
  # shellcheck disable=SC2086
  $checksum_cmd "$file" | awk '{print $1}'
}

size_of() {
  local file="$1"
  if stat -c '%s' "$file" >/dev/null 2>&1; then
    stat -c '%s' "$file"
  else
    wc -c < "$file" | tr -d ' '
  fi
}

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$DEST/dextube-$STAMP"

VERSION="$(grep -m1 '"version"' "$ROOT_DIR/package.json" 2>/dev/null | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/' || true)"
[[ -n "$VERSION" ]] || VERSION="unknown"

# ============================================================= 1. prepare ===
say "Preparing backup directory"
mkdir -p "$DEST"
if ! mkdir "$BACKUP_DIR" 2>/dev/null; then
  die "Backup directory already exists — refusing to overwrite: $BACKUP_DIR"
fi
ok "$BACKUP_DIR"

# ============================================================== 2. database =
say "Dumping database"
db_method=""
container_running=false
if command -v docker >/dev/null 2>&1 \
   && [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" == "true" ]]; then
  container_running=true
fi

if [[ "$container_running" == true ]]; then
  db_method="docker exec $CONTAINER_NAME pg_dump"
  if ! docker exec "$CONTAINER_NAME" pg_dump \
        -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl \
        | gzip -c > "$BACKUP_DIR/database.sql.gz"; then
    die "pg_dump via docker exec failed (see: docker logs $CONTAINER_NAME)."
  fi
  ok "database dumped via the running container."
else
  if ! command -v pg_dump >/dev/null 2>&1; then
    die "The container '$CONTAINER_NAME' is not running and no host 'pg_dump' is installed.
       Start the container (bash scripts/db-up.sh) or install the postgresql client tools:
           sudo dnf install postgresql"
  fi
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in .env; cannot dump with the host pg_dump."
  db_method="host pg_dump (DATABASE_URL)"
  if ! pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip -c > "$BACKUP_DIR/database.sql.gz"; then
    die "pg_dump via DATABASE_URL failed."
  fi
  ok "database dumped with the host pg_dump."
fi

if [[ ! -s "$BACKUP_DIR/database.sql.gz" ]]; then
  die "database.sql.gz is empty — the dump did not succeed."
fi

# ================================================================= 3. media =
say "Archiving media directory (${MEDIA_ROOT})"
mkdir -p "$MEDIA_ABS"
if ! tar -czf "$BACKUP_DIR/media.tar.gz" -C "$MEDIA_ABS" .; then
  die "tar of MEDIA_ROOT failed ($MEDIA_ABS)."
fi
if [[ ! -s "$BACKUP_DIR/media.tar.gz" ]]; then
  die "media.tar.gz is empty — the archive did not succeed."
fi
ok "media archived."

# ============================================================= 4. manifest =
say "Writing manifest"
{
  echo "dextube-backup: 1"
  echo "timestamp: $(date -Is)"
  echo "version: $VERSION"
  echo "database: $POSTGRES_DB"
  echo "database_method: $db_method"
  echo "media_root: $MEDIA_ROOT"
  echo "media_root_absolute: $MEDIA_ABS"
  echo "artifacts:"
  for f in database.sql.gz media.tar.gz; do
    printf '  %s size=%s sha256=%s\n' "$f" "$(size_of "$BACKUP_DIR/$f")" "$(checksum_of "$BACKUP_DIR/$f")"
  done
} > "$BACKUP_DIR/manifest.txt"
ok "manifest written."

# ============================================================== 5. report ==
step_bytes="$(du -sh "$BACKUP_DIR" 2>/dev/null | awk '{print $1}' || echo '?')"
say "Backup complete (${step_bytes:-?}): $BACKUP_DIR"
echo
echo "Restore with:"
echo "  bash \"$ROOT_DIR/scripts/restore.sh\" \"$BACKUP_DIR\" --yes"
