#!/usr/bin/env bash
# Blocks private data from entering git history.
#
#   check-private-data.sh --staged        check files staged for commit (pre-commit hook)
#   check-private-data.sh --message FILE  check a commit message (commit-msg hook)
#   check-private-data.sh                 check every tracked file (CI and manual use)
#
# Two layers:
#   1. Forbidden paths: env files, keys, certificates, databases, backups, and
#      private agent notes (*.local.md) may never be committed.
#   2. Private terms: an optional, gitignored `.private-terms` file at the repo
#      root lists one extended regex per line (case-insensitive) for names that
#      must never appear in the repo or in commit messages, such as personal
#      hostnames, private network domains, usernames, or private project names.
#      Lines starting with # and blank lines are ignored. The file is local so
#      the denylist itself never becomes public.
set -euo pipefail
shopt -s nocasematch

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="tracked"
MESSAGE_FILE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --message) MODE="message"; MESSAGE_FILE="${2:?--message requires a file}" ;;
  "") ;;
  *) echo "usage: $0 [--staged | --message FILE]" >&2; exit 2 ;;
esac

TERMS_FILE="$ROOT_DIR/.private-terms"
TERMS_PATTERN=""
if [[ -f "$TERMS_FILE" ]]; then
  TERMS_PATTERN="$(grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" | paste -sd '|' - || true)"
fi

if [[ -n "$TERMS_PATTERN" ]]; then
  if grep -qiE -- "$TERMS_PATTERN" </dev/null; then :
  elif [[ "$?" -gt 1 ]]; then
    echo 'private-data check: invalid regular expression in .private-terms' >&2
    exit 2
  fi
fi

FORBIDDEN_PATHS='(^|/)\.env($|\.)|(^|/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)(-(wal|shm|journal))?$|(^|/)(certs|backups|state|artifacts|\.ardent|\.magnus|\.hive-dev|\.ssh|audit-logs|terminal-audit)/|(^|/)[^/]+\.local\.md$|(^|/)\.private-terms$|(^|/)\.vscode/mcp\.json$'
ALLOWED_PATHS='\.env\.example$'

failures=0
fail() {
  printf 'private-data check: %s\n' "$1" >&2
  failures=$((failures + 1))
}

if [[ "$MODE" == "message" ]]; then
  if [[ -n "$TERMS_PATTERN" ]] && grep -vE '^#' "$MESSAGE_FILE" | grep -qiE -- "$TERMS_PATTERN"; then
    fail "commit message contains a term listed in .private-terms"
  fi
  [[ "$failures" -eq 0 ]] || exit 1
  exit 0
fi

if [[ "$MODE" == "staged" ]]; then
  mapfile -d '' -t files < <(git diff --cached --name-only --diff-filter=ACMR -z)
else
  mapfile -d '' -t files < <(git ls-files -z)
fi

for file in "${files[@]}"; do
  [[ -n "$file" ]] || continue
  if [[ "$file" =~ $FORBIDDEN_PATHS && ! "$file" =~ $ALLOWED_PATHS ]]; then
    fail "forbidden file: $file"
  fi
done

if [[ -n "$TERMS_PATTERN" && "${#files[@]}" -gt 0 ]]; then
  index_file="$(mktemp)"
  trap 'rm -f "$index_file"' EXIT
  for file in "${files[@]}"; do
    [[ -n "$file" ]] || continue
    if [[ "$MODE" == "staged" ]]; then
      git show ":$file" > "$index_file"
      content_file="$index_file"
    else
      [[ -f "$file" ]] || continue
      content_file="$file"
    fi
    if matches="$(grep -naiE -- "$TERMS_PATTERN" "$content_file" | cut -d: -f1)"; then
      while IFS= read -r line; do
        fail "private term in $file:$line [redacted]"
      done <<< "$matches"
    fi
    if grep -qiE -- "$TERMS_PATTERN" <<< "$file"; then
      fail "private term in file name: $file"
    fi
  done
fi

if [[ "$failures" -gt 0 ]]; then
  echo "private-data check failed with $failures finding(s). Remove the data, or genericize it (example.com hosts, env vars)." >&2
  exit 1
fi
echo "Private data check passed."
