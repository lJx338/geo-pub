#!/bin/sh
set -eu

VERSION=${1:?usage: migrate-release-layout.sh version}
: "${TENCENT_CLOUD_SECRET_ID:?missing TENCENT_CLOUD_SECRET_ID}"
: "${TENCENT_CLOUD_SECRET_KEY:?missing TENCENT_CLOUD_SECRET_KEY}"
: "${TENCENT_COS_BUCKET:?missing TENCENT_COS_BUCKET}"
: "${TENCENT_COS_REGION:?missing TENCENT_COS_REGION}"

PREFIX=${TENCENT_COS_PREFIX:-geo-publisher}
PUBLIC_RELEASE_BASE=${GEO_UPDATE_PUBLIC_BASE:-https://${TENCENT_COS_BUCKET}.cos.${TENCENT_COS_REGION}.myqcloud.com/${PREFIX}/releases}
COS_HOST=${TENCENT_COS_BUCKET}.cos.${TENCENT_COS_REGION}.myqcloud.com
WORK_DIR=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/geo-publisher-migration
CONFIG=$WORK_DIR/cos.conf

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

coscmd -c "$CONFIG" config \
  -a "$TENCENT_CLOUD_SECRET_ID" \
  -s "$TENCENT_CLOUD_SECRET_KEY" \
  -b "$TENCENT_COS_BUCKET" \
  -r "$TENCENT_COS_REGION" \
  --retry 5 --timeout 120

for target in win-x64 mac-arm64; do
  if [ "$target" = "mac-arm64" ]; then
    stable_manifest=latest-mac.yml
    legacy_beta_manifest=beta-mac.yml
  else
    stable_manifest=latest.yml
    legacy_beta_manifest=beta.yml
  fi

  source_manifest="$WORK_DIR/$target-$stable_manifest"
  rendered_manifest="$WORK_DIR/$target-channel.yml"
  curl -fsSL --retry 5 \
    "$PUBLIC_RELEASE_BASE/stable/$target/$stable_manifest" \
    -o "$source_manifest"

  actual_version=$(node -e "const fs=require('fs');const YAML=require('yaml');process.stdout.write(String(YAML.parse(fs.readFileSync(process.argv[1],'utf8')).version||''))" "$source_manifest")
  [ "$actual_version" = "$VERSION" ] || {
    echo "legacy $target manifest is $actual_version, expected $VERSION" >&2
    exit 1
  }

  version_key="$PREFIX/releases/versions/$VERSION/$target"
  version_url="$PUBLIC_RELEASE_BASE/versions/$VERSION/$target"

  # COS performs this copy server-side, so migration does not re-upload large installers.
  coscmd -c "$CONFIG" copy -r -f -y \
    "$COS_HOST/$PREFIX/releases/stable/$target/" \
    "$version_key/"

  node scripts/render-channel-manifest.mjs \
    "$source_manifest" "$rendered_manifest" "$version_url"

  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"public, max-age=31536000, immutable"}' \
    "$rendered_manifest" "$version_key/$stable_manifest"
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/channels/stable/$target/$stable_manifest"
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/stable/$target/$stable_manifest"
  coscmd -c "$CONFIG" upload -f -y \
    -H '{"Cache-Control":"no-cache, no-store, must-revalidate"}' \
    "$rendered_manifest" "$PREFIX/releases/beta/$target/$legacy_beta_manifest"
done
