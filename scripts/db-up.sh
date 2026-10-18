#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEXTube - start local development services (PostgreSQL, optional Redis)
#
# Tries, in order:
#   1. `docker compose`
#   2. `docker-compose`
#   3. plain `docker run` (works on a bare Fedora install without the
#      compose plugin)
#
# Reads POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB from .env
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Run: cp .env.example .env  and set POSTGRES_PASSWORD." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source <(grep -E '^(POSTGRES_|DATABASE_URL|REDIS_URL)' .env | sed 's/\r$//')
set +a

: "${POSTGRES_USER:=dextube}"
: "${POSTGRES_DB:=dextube}"
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "ERROR: POSTGRES_PASSWORD is empty in .env" >&2
  exit 1
fi

CONTAINER_NAME=dextube-postgres
HOST_PORT=5433

container_state() {
  docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "absent"
}

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    echo "[db-up] using 'docker compose'"
    docker compose up -d postgres
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "[db-up] using 'docker-compose'"
    docker-compose up -d postgres
  else
    echo "[db-up] compose plugin not found; using plain 'docker run'"
    state="$(container_state)"
    if [[ "$state" == "true" ]]; then
      echo "[db-up] container $CONTAINER_NAME already running"
    else
      docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
      docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        -e POSTGRES_USER="$POSTGRES_USER" \
        -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
        -e POSTGRES_DB="$POSTGRES_DB" \
        -p "127.0.0.1:${HOST_PORT}:5432" \
        -v dextube_pgdata:/var/lib/postgresql/data \
        postgres:16-alpine \
        postgres -c max_connections=50 -c shared_buffers=128MB -c work_mem=8MB >/dev/null
      echo "[db-up] started $CONTAINER_NAME on 127.0.0.1:${HOST_PORT}"
    fi
  fi
else
  echo "ERROR: docker not found. Install PostgreSQL natively or install Docker." >&2
  exit 1
fi

echo -n "[db-up] waiting for PostgreSQL"
for _ in $(seq 1 40); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo " ... ready"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo
echo "ERROR: PostgreSQL did not become ready in time." >&2
docker logs --tail 40 "$CONTAINER_NAME" >&2 || true
exit 1
