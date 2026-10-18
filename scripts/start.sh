#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - start the application
#
# WHAT IT DOES
#   1. Verifies .env exists (aborts with a clear message if not).
#   2. Starts the local PostgreSQL container via scripts/db-up.sh.
#   3. Waits for the database to accept connections (bounded timeout).
#   4. Applies migrations: `npx prisma migrate deploy`.
#   5. Runs `npm run doctor` and aborts on a non-zero exit so misconfiguration
#      is caught before any traffic is served.
#   6. Starts the web app (development by default, production with --prod).
#   7. Starts `npm run worker` when JOB_RUNNER=external, otherwise skips it.
#
# Logs go to storage/logs/*.log and PIDs to storage/run/*.pid so scripts/stop.sh
# can find the processes it started. Each service is launched in its own session
# (via setsid) so stop.sh can cleanly signal the whole process tree.
#
# USAGE
#   bash scripts/start.sh              # development (npm run dev)
#   bash scripts/start.sh --prod       # production (npm run build && npm start)
#   bash scripts/start.sh --help
#
#   --dev / --production are accepted as aliases. DEXTUBE_MODE=production also
#   selects production mode. Default is development.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="$ROOT_DIR/storage/logs"
RUN_DIR="$ROOT_DIR/storage/run"
DB_WAIT_SECONDS="${DEXTUBE_DB_WAIT_SECONDS:-60}"

# ------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  _reset=$'\033[0m'; _bold=$'\033[1m'
  _red=$'\033[31m'; _grn=$'\033[32m'; _yel=$'\033[33m'; _blu=$'\033[34m'
else
  _reset=''; _bold=''; _red=''; _grn=''; _yel=''; _blu=''
fi

say()  { printf '%s %s\n' "${_blu}[start]${_reset}" "$*"; }
step() { printf '\n%s\n' "${_bold}==> $*${_reset}"; }
ok()   { printf '%s %s\n' "${_grn}[ ok ]${_reset}" "$*"; }
warn() { printf '%s %s\n' "${_yel}[warn]${_reset}" "$*" >&2; }
die()  { printf '%s %s\n' "${_red}[fail]${_reset}" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
DEXTube - start the application

Usage:
  bash scripts/start.sh [--prod|--production|--dev] [--help]

Modes:
  (default)        development: npm run dev
  --prod           production:  npm run build, then npm start
  --dev            explicit development (same as default)

Environment:
  DEXTUBE_MODE=production   selects production mode
  DEXTUBE_DB_WAIT_SECONDS   database readiness timeout (default 60)
  JOB_RUNNER=external       also starts `npm run worker`

Starts the database through scripts/db-up.sh, applies migrations, runs the
preflight doctor, then launches the app in the background, writing logs to
storage/logs/ and PIDs to storage/run/.
EOF
}

MODE="development"
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --prod|--production) MODE="production" ;;
    --dev|--development) MODE="development" ;;
    "") ;;
    *) die "Unknown argument: $arg (try --help)" ;;
  esac
done
if [[ "${DEXTUBE_MODE:-}" == "production" ]]; then
  MODE="production"
fi

# ----------------------------------------------------- read values from .env
# Extracts a single key without sourcing the file (values may contain spaces or
# shell metacharacters, so `source` would be unsafe).
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

# --------------------------------------------------- database URL parsing
# Splits postgresql://user:pass@host:port/db?params into db_host/db_port.
parse_database_url() {
  local url="${1:-}" rest hostport
  db_host="localhost"
  db_port="5433"
  [[ -z "$url" ]] && return 0
  rest="${url#*://}"
  [[ "$rest" == *"@"* ]] && rest="${rest#*@}"
  hostport="${rest%%/*}"
  hostport="${hostport%%\?*}"
  if [[ -n "$hostport" ]]; then
    if [[ "$hostport" == *":"* ]]; then
      db_host="${hostport%%:*}"
      db_port="${hostport##*:}"
    else
      db_host="$hostport"
      db_port="5432"
    fi
  fi
}

db_accepting_connections() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$db_host" -p "$db_port" -t 1 >/dev/null 2>&1
  else
    # psql-free TCP reachability probe using bash's /dev/tcp.
    timeout 2 bash -c "exec 3<>/dev/tcp/${db_host}/${db_port}" >/dev/null 2>&1
  fi
}

# ------------------------------------------------------ background launcher
start_service() {
  local name="$1"; shift
  local pidfile="$RUN_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"

  if [[ -f "$pidfile" ]]; then
    local old
    old="$(cut -d' ' -f1 < "$pidfile" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      warn "$name already appears to be running (pid $old); not starting another."
      warn "Run 'bash scripts/stop.sh' first if that is stale."
      return 0
    fi
    rm -f "$pidfile"
  fi

  say "starting $name: $*"
  # Launch as a session leader so the whole process tree shares one PGID and
  # scripts/stop.sh can terminate it as a unit. `$!` is that session leader.
  setsid -- "$@" >>"$logfile" 2>&1 &
  local pid=$!

  # Confirm it survived the first moment (catches an immediate crash).
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    warn "$name exited immediately. Last 30 log lines:"
    tail -n 30 "$logfile" >&2 || true
    die "$name failed to start (see ${logfile#"$ROOT_DIR"/})."
  fi

  echo "$pid" > "$pidfile"
  ok "$name started (pid $pid) — log: ${logfile#"$ROOT_DIR"/}"
}

# ================================================================ 1. .env ===
step "Checking environment"
if [[ ! -f .env ]]; then
  die ".env not found. Create it first:
       cp .env.example .env
     then set POSTGRES_PASSWORD and SESSION_SECRET (openssl rand -base64 48)."
fi
ok ".env is present."

mkdir -p "$LOG_DIR" "$RUN_DIR"

# ============================================================ 2. database ===
step "Starting database"
if ! bash "$ROOT_DIR/scripts/db-up.sh"; then
  warn "scripts/db-up.sh did not succeed."
  warn "Continuing on the assumption that DATABASE_URL points at an external PostgreSQL."
fi

# ============================================================== 3. wait DB ===
step "Waiting for the database (timeout ${DB_WAIT_SECONDS}s)"
database_url="$(env_value DATABASE_URL || true)"
parse_database_url "$database_url"
say "target: ${db_host}:${db_port}"

db_ready=false
for (( i=1; i<=DB_WAIT_SECONDS; i++ )); do
  if db_accepting_connections; then
    db_ready=true
    break
  fi
  sleep 1
done
if [[ "$db_ready" != true ]]; then
  die "the database at ${db_host}:${db_port} did not accept connections within ${DB_WAIT_SECONDS}s.
       Troubleshooting: bash scripts/db-up.sh ; docker logs dextube-postgres ; see docs/fedora.md"
fi
ok "database is accepting connections."

# ========================================================= 4. migrations ===
step "Applying database migrations"
npx prisma migrate deploy
ok "migrations applied."

# ============================================================= 5. doctor ===
step "Running preflight (npm run doctor)"
if ! npm run doctor; then
  die "preflight failed — fix the failures reported above before starting DEXTube."
fi

# ============================================================== 6. app ======
bind_host="$(env_value BIND_HOST || echo '127.0.0.1')"
port="$(env_value PORT || echo '3000')"

if [[ "$MODE" == "production" ]]; then
  step "Building for production"
  # pipefail (from set -euo pipefail) ensures a failed build aborts here.
  npm run build 2>&1 | tee -a "$LOG_DIR/build.log"
  ok "production build complete — log: ${LOG_DIR#"$ROOT_DIR"/}/build.log"
  step "Starting DEXTube (production)"
  export PORT="$port"
  start_service app npm start -- -H "$bind_host"
else
  step "Starting DEXTube (development)"
  export PORT="$port"
  start_service app npm run dev -- -H "$bind_host"
fi

# ============================================================= 7. worker ===
step "Checking background worker"
job_runner="$(env_value JOB_RUNNER || echo 'inline')"
if [[ "$job_runner" == "external" ]]; then
  start_service worker npm run worker
else
  ok "JOB_RUNNER=${job_runner} — jobs run inline in the web process; no worker started."
  say "  (set JOB_RUNNER=external in .env to run a dedicated worker)"
fi

# ============================================================== 8. report ===
display_host="$bind_host"
[[ "$display_host" == "0.0.0.0" || "$display_host" == "::" ]] && display_host="localhost"

step "DEXTube is starting"
cat <<EOF
  Mode        : ${MODE}
  URL         : http://${display_host}:${port}
  App log     : storage/logs/app.log
  PID files   : storage/run/*.pid
  Follow logs : tail -f storage/logs/app.log
  Stop        : bash scripts/stop.sh            (add --with-db to stop PostgreSQL)
EOF
if [[ "$job_runner" == "external" ]]; then
  say "Worker log  : storage/logs/worker.log"
fi
say "The app is running in the background; this command has finished."
