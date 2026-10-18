#!/usr/bin/env bash
#
# Seed the database.
#
# This wrapper exists because two runners need to launch the seed with
# `NODE_OPTIONS=--conditions=react-server` (the condition that lets
# `src/server/**` import `server-only` outside a Next.js build):
#
#   * `npm run db:seed`
#   * `npx prisma db seed` / `prisma migrate reset` — Prisma spawns the command
#     configured under `package.json#prisma.seed` *without* a shell, so an
#     inline `VAR=value cmd` prefix fails with ENOENT. Delegating to this script
#     keeps one code path for both.
#
# Usage: bash scripts/seed.sh        (or: npm run db:seed)
set -euo pipefail

cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=react-server"

if [ -x ./node_modules/.bin/tsx ]; then
  exec ./node_modules/.bin/tsx prisma/seed.ts
fi

exec npx --no-install tsx prisma/seed.ts
