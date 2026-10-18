#!/usr/bin/env bash
#
# Run any command with the isolated test environment loaded.
#
#   bash scripts/isolated.sh npx tsx scripts/isolated-reset.ts --dry-run
#   npm run isolated:dev
#
# The values from `.env.isolated-test` are exported into the child process, so
# Next.js (which never overrides variables that are already set) and the
# `tsx` scripts (which read `DEXTUBE_ENV_FILE`) all see the same configuration.
#
# Every value in the generated file is single-quoted, which is what makes
# sourcing it safe: no word splitting, no globbing, no command substitution.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${DEXTUBE_ISOLATED_ENV_FILE:-.env.isolated-test}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'The isolated environment file %s does not exist.\n' "$ENV_FILE" >&2
  printf 'Create it first:  npm run isolated:setup\n' >&2
  exit 1
fi

# Refuse to source anything that is not a plain KEY='value' file. This is a
# guard against accidentally pointing the wrapper at a hand-edited file that
# contains shell commands.
if grep -vE "^[[:space:]]*(#|$)" "$ENV_FILE" | grep -qvE "^[A-Za-z_][A-Za-z0-9_]*="; then
  printf 'Refusing to source %s: it contains a line that is not KEY=value.\n' "$ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

# Tells `loadEnvFile()` in the tsx scripts to read the same file.
export DEXTUBE_ENV_FILE="$ENV_FILE"

if [[ "${DEXTUBE_ENV:-}" != "isolated-test" ]]; then
  printf 'Refusing to continue: %s must set DEXTUBE_ENV=isolated-test (found "%s").\n' \
    "$ENV_FILE" "${DEXTUBE_ENV:-unset}" >&2
  exit 1
fi

exec "$@"
