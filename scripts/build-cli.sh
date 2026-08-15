#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/cli"
DEV_OUT="$ROOT/.dev-cli"
VERSION=$(node -p "require('$ROOT/package.json').version")
MODE=${1:-production}

cd "$ROOT/cli"
go mod download

PROD_FLAGS="-s -w -X main.version=$VERSION -X main.buildMode=production"
DEV_FLAGS="-s -w -X main.version=$VERSION -X main.buildMode=development"

if [ "$MODE" = "production" ] || [ "$MODE" = "all" ]; then
  rm -rf "$OUT"
  mkdir -p "$OUT"
  # Only these production binaries are packaged and exposed to WorkBuddy.
  GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="$PROD_FLAGS" -o "$OUT/geo-publisher-darwin-arm64" .
  GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="$PROD_FLAGS" -o "$OUT/geo-publisher-windows-amd64.exe" .
  echo "Built production CLI binaries in $OUT"
fi

if [ "$MODE" = "development" ] || [ "$MODE" = "all" ]; then
  rm -rf "$DEV_OUT"
  mkdir -p "$DEV_OUT"
  # Developer binaries keep diagnostic and project-administration commands.
  # They deliberately live outside dist/ so Electron packaging cannot ship them.
  GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="$DEV_FLAGS" -o "$DEV_OUT/geo-publisher-dev-darwin-arm64" .
  GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="$DEV_FLAGS" -o "$DEV_OUT/geo-publisher-dev-windows-amd64.exe" .
  echo "Built developer-only CLI binaries in $DEV_OUT (never packaged)"
fi

if [ "$MODE" != "production" ] && [ "$MODE" != "development" ] && [ "$MODE" != "all" ]; then
  echo "Unknown CLI build mode: $MODE" >&2
  exit 2
fi
