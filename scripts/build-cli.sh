#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/cli"
VERSION=$(node -p "require('$ROOT/package.json').version")

mkdir -p "$OUT"
cd "$ROOT/cli"
go mod download

GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$OUT/geo-publisher-darwin-arm64" .
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$OUT/geo-publisher-windows-amd64.exe" .

echo "Built CLI binaries in $OUT"
