#!/usr/bin/env bash
# DEXTube - stop local development services (data volume is preserved).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
CONTAINER_NAME=dextube-postgres

if docker compose version >/dev/null 2>&1; then
  docker compose stop postgres
  docker compose --profile cache stop redis 2>/dev/null || true
else
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 && echo "stopped $CONTAINER_NAME" || echo "$CONTAINER_NAME not running"
fi
echo "Data volume dextube_pgdata preserved. Use 'docker volume rm dextube_pgdata' to delete (destructive)."
