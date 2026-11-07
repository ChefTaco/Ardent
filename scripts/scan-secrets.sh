#!/usr/bin/env bash
# Scan working and staged content without printing credential values.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/scan-secrets.mjs" "$@"
