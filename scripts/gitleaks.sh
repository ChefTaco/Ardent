#!/usr/bin/env bash
# Scan exact staged bytes or immutable outgoing history. Never print secret values.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version=8.30.1
binary="${XDG_CACHE_HOME:-$HOME/.cache}/hivemagnus-tools/gitleaks/$version/gitleaks"
if [[ ! -x "$binary" ]]; then
  binary="$(command -v gitleaks || true)"
fi
if [[ -z "$binary" ]] || [[ "$("$binary" version)" != "$version" ]]; then
  echo 'Gitleaks 8.30.1 is required. Run: bash scripts/install-gitleaks.sh' >&2
  exit 2
fi
options=(--gitleaks-ignore-path /dev/null
  --redact=100 --ignore-gitleaks-allow --no-banner --no-color --log-level=warn)
scan_history() {
  git rev-parse --verify "$1^{commit}" >/dev/null
  "$binary" git --config "$root/.gitleaks.toml" "${options[@]}" --log-opts="$2" "$root"
}
case "${1:---staged}" in
  --staged)
    umask 077
    temporary="$(mktemp -d)"
    trap 'rm -rf "$temporary"' EXIT
    # Export the index, including force-added ignored files. Working-tree edits,
    # untracked files, .gitignore and partial staging cannot hide staged secrets.
    git checkout-index --all --prefix="$temporary/"
    if [[ ! -f "$temporary/.gitleaks.toml" ]]; then
      echo 'Stage .gitleaks.toml before running the staged scan.' >&2
      exit 2
    fi
    (cd "$temporary"; "$binary" dir --config "$temporary/.gitleaks.toml" "${options[@]}" .)
    ;;
  --history)
    if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
      echo 'Full history is required; fetch with depth 0 before scanning.' >&2
      exit 2
    fi
    scan_history HEAD HEAD
    ;;
  --pre-push)
    if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
      echo 'Full history is required before pushing; fetch with depth 0.' >&2
      exit 2
    fi
    while read -r local_ref local_sha remote_ref remote_sha; do
      [[ -n "$local_ref" && -n "$remote_ref" ]] || { echo 'Invalid pre-push input.' >&2; exit 2; }
      [[ "$local_sha" =~ ^[0-9a-f]{40,64}$ && "$remote_sha" =~ ^[0-9a-f]{40,64}$ ]] || exit 2
      [[ "$local_sha" =~ ^0+$ ]] && continue # Ref deletion carries no new content.
      if [[ "$remote_sha" =~ ^0+$ ]]; then
        scan_history "$local_sha" "$local_sha"
      elif git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
        scan_history "$local_sha" "$remote_sha..$local_sha"
      else
        # Unknown remote base: scan all reachable commits instead of skipping.
        scan_history "$local_sha" "$local_sha"
      fi
    done
    ;;
  *) echo 'Usage: bash scripts/gitleaks.sh --staged|--history|--pre-push' >&2; exit 2 ;;
esac
