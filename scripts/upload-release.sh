#!/bin/sh
set -eu

DIRECTORY=${1:?usage: upload-release.sh directory target channel}
TARGET=${2:?usage: upload-release.sh directory target channel}
CHANNEL=${3:?usage: upload-release.sh directory target channel}

case "$TARGET" in win-x64) ;; *) echo "unsupported target: $TARGET" >&2; exit 1 ;; esac
case "$CHANNEL" in stable|beta) ;; *) echo "unsupported channel: $CHANNEL" >&2; exit 1 ;; esac

: "${TENCENT_CLOUD_SECRET_ID:?missing TENCENT_CLOUD_SECRET_ID}"
: "${TENCENT_CLOUD_SECRET_KEY:?missing TENCENT_CLOUD_SECRET_KEY}"
: "${TENCENT_COS_BUCKET:?missing TENCENT_COS_BUCKET}"
: "${TENCENT_COS_REGION:?missing TENCENT_COS_REGION}"

PREFIX=${TENCENT_COS_PREFIX:-geo-publisher}
CONFIG=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/geo-publisher-cos.conf
rm -f "$CONFIG"
trap 'rm -f "$CONFIG"' EXIT INT TERM

coscmd -c "$CONFIG" config \
  -a "$TENCENT_CLOUD_SECRET_ID" \
  -s "$TENCENT_CLOUD_SECRET_KEY" \
  -b "$TENCENT_COS_BUCKET" \
  -r "$TENCENT_COS_REGION" \
  --retry 5 --timeout 120

found_artifact=0
for file in "$DIRECTORY"/*.exe "$DIRECTORY"/*.blockmap; do
  [ -f "$file" ] || continue
  found_artifact=1
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"public, max-age=31536000, immutable"}' \
    "$file" "$PREFIX/releases/$CHANNEL/$TARGET/$(basename "$file")"
done
[ "$found_artifact" -eq 1 ] || { echo "no Windows release artifact found" >&2; exit 1; }

if [ "$CHANNEL" = "beta" ]; then
  manifest_name=beta.yml
else
  manifest_name=latest.yml
fi
found_manifest=0
for file in "$DIRECTORY/$manifest_name"; do
  [ -f "$file" ] || continue
  found_manifest=1
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$file" "$PREFIX/releases/$CHANNEL/$TARGET/$(basename "$file")"
done
[ "$found_manifest" -eq 1 ] || { echo "no update manifest found" >&2; exit 1; }
