#!/bin/sh
set -eu

DIRECTORY=${1:?usage: upload-release.sh directory target channel}
TARGET=${2:?usage: upload-release.sh directory target channel}
CHANNEL=${3:?usage: upload-release.sh directory target channel}

case "$TARGET" in win-x64|mac-arm64) ;; *) echo "unsupported target: $TARGET" >&2; exit 1 ;; esac
case "$CHANNEL" in stable|beta) ;; *) echo "unsupported channel: $CHANNEL" >&2; exit 1 ;; esac

: "${TENCENT_CLOUD_SECRET_ID:?missing TENCENT_CLOUD_SECRET_ID}"
: "${TENCENT_CLOUD_SECRET_KEY:?missing TENCENT_CLOUD_SECRET_KEY}"
: "${TENCENT_COS_BUCKET:?missing TENCENT_COS_BUCKET}"
: "${TENCENT_COS_REGION:?missing TENCENT_COS_REGION}"

PREFIX=${TENCENT_COS_PREFIX:-geo-publisher}
CONFIG=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/geo-publisher-cos.conf

if [ "$TARGET" = "mac-arm64" ] && [ "$CHANNEL" = "beta" ]; then
  manifest_name=beta-mac.yml
elif [ "$TARGET" = "mac-arm64" ]; then
  manifest_name=latest-mac.yml
elif [ "$CHANNEL" = "beta" ]; then
  manifest_name=beta.yml
else
  manifest_name=latest.yml
fi
manifest_file="$DIRECTORY/$manifest_name"
[ -f "$manifest_file" ] || { echo "no update manifest found: $manifest_file" >&2; exit 1; }
VERSION=$(node -e "const fs=require('fs');const YAML=require('yaml');process.stdout.write(String(YAML.parse(fs.readFileSync(process.argv[1],'utf8')).version||''))" "$manifest_file")
[ -n "$VERSION" ] || { echo "update manifest has no version" >&2; exit 1; }

PUBLIC_RELEASE_BASE=${GEO_UPDATE_PUBLIC_BASE:-https://${TENCENT_COS_BUCKET}.cos.${TENCENT_COS_REGION}.myqcloud.com/${PREFIX}/releases}
VERSION_KEY="$PREFIX/releases/versions/$VERSION/$TARGET"
VERSION_URL="$PUBLIC_RELEASE_BASE/versions/$VERSION/$TARGET"
rm -f "$CONFIG"
trap 'rm -f "$CONFIG"' EXIT INT TERM

coscmd -c "$CONFIG" config \
  -a "$TENCENT_CLOUD_SECRET_ID" \
  -s "$TENCENT_CLOUD_SECRET_KEY" \
  -b "$TENCENT_COS_BUCKET" \
  -r "$TENCENT_COS_REGION" \
  --retry 5 --timeout 120

found_artifact=0
for file in "$DIRECTORY"/*.exe "$DIRECTORY"/*.dmg "$DIRECTORY"/*.zip "$DIRECTORY"/*.blockmap; do
  [ -f "$file" ] || continue
  found_artifact=1
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"public, max-age=31536000, immutable"}' \
    "$file" "$VERSION_KEY/$(basename "$file")"
done
[ "$found_artifact" -eq 1 ] || { echo "no release artifact found for $TARGET" >&2; exit 1; }

rendered_manifest="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$manifest_name"
node scripts/render-channel-manifest.mjs "$manifest_file" "$rendered_manifest" "$VERSION_URL"

# Keep an immutable copy beside the artifacts for auditing and recovery.
coscmd -c "$CONFIG" upload -f -y \
  -H '{"Cache-Control":"public, max-age=31536000, immutable"}' \
  "$rendered_manifest" "$VERSION_KEY/$manifest_name"

# New clients read the channel pointer. It is uploaded only after all artifacts.
coscmd -c "$CONFIG" upload -f -y \
  -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
  "$rendered_manifest" "$PREFIX/releases/channels/$CHANNEL/$TARGET/$manifest_name"

if [ "$CHANNEL" = "stable" ]; then
  if [ "$TARGET" = "mac-arm64" ]; then
    compatibility_manifest=stable-mac.yml
  else
    compatibility_manifest=stable.yml
  fi

  # 0.2.0 set electron-updater's channel to "stable" and requests this name.
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/channels/stable/$TARGET/$compatibility_manifest"

  # 0.2.0 and older stable clients use this legacy feed path.
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/stable/$TARGET/$manifest_name"

  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/stable/$TARGET/$compatibility_manifest"

  # One-way migration for historical beta clients. New beta builds use channels/beta.
  if [ "$TARGET" = "mac-arm64" ]; then
    legacy_beta_manifest=beta-mac.yml
  else
    legacy_beta_manifest=beta.yml
  fi
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/beta/$TARGET/$legacy_beta_manifest"
fi
