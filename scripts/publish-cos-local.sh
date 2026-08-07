#!/bin/sh
set -eu

RUN_ID=${1:?usage: publish-cos-local.sh <github-run-id> <beta|stable>}
CHANNEL=${2:?usage: publish-cos-local.sh <github-run-id> <beta|stable>}
case "$CHANNEL" in beta|stable) ;; *) echo "Unsupported channel: $CHANNEL" >&2; exit 1 ;; esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT="$ROOT/release/local-upload/$RUN_ID"
WINDOWS_OUTPUT="$OUTPUT/win-x64"
MAC_OUTPUT="$OUTPUT/mac-arm64"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) is required." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI is not logged in. Run: gh auth login" >&2; exit 1; }

mkdir -p "$WINDOWS_OUTPUT" "$MAC_OUTPUT"

if [ ! -f "$WINDOWS_OUTPUT/beta.yml" ] && [ ! -f "$WINDOWS_OUTPUT/latest.yml" ]; then
  gh run download "$RUN_ID" -n geo-publisher-windows -D "$WINDOWS_OUTPUT"
fi
if [ ! -f "$MAC_OUTPUT/beta-mac.yml" ] && [ ! -f "$MAC_OUTPUT/latest-mac.yml" ]; then
  gh run download "$RUN_ID" -n geo-publisher-macos-arm64 -D "$MAC_OUTPUT"
fi

"$ROOT/scripts/upload-cos-local.sh" "$WINDOWS_OUTPUT" win-x64 "$CHANNEL"
"$ROOT/scripts/upload-cos-local.sh" "$MAC_OUTPUT" mac-arm64 "$CHANNEL"

echo "COS release completed: run=$RUN_ID channel=$CHANNEL"
