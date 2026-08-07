#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${GEO_COS_ENV_FILE:-"$ROOT/.env.cos"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE" >&2
  echo "Copy .env.cos.example to .env.cos and fill in the COS values." >&2
  exit 1
fi

# The env file is local-only and is ignored by git.
set -a
. "$ENV_FILE"
set +a

exec node "$ROOT/scripts/upload-release.mjs" "$@"
