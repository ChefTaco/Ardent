#!/usr/bin/env bash
# Regression checks use only generated, synthetic credentials in disposable repos.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
# Hooks pass Git environment variables; never let fixtures modify the caller's index.
for variable in $(git rev-parse --local-env-vars); do unset "$variable"; done
mkdir -p "$temporary/repository/scripts"
cp "$root/scripts/gitleaks.sh" "$temporary/repository/scripts/"
cp "$root/.gitleaks.toml" "$temporary/repository/"
cd "$temporary/repository"
git init -q
git config user.name 'Security Fixture'
git config user.email 'fixture@example.com'
git config core.hooksPath /dev/null
expect_status() {
  expected="$1"; shift
  actual=0
  "$@" >"$temporary/output" 2>&1 || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected exit $expected, received $actual: $*" >&2
    cat "$temporary/output" >&2
    exit 1
  fi
}
printf 'ordinary text\n' > clean.txt
git add clean.txt .gitleaks.toml scripts/gitleaks.sh
expect_status 0 bash scripts/gitleaks.sh --staged
git commit -qm 'test: clean fixture'
base="$(git rev-parse HEAD)"
# Assembled here so the test source itself contains no credential-shaped token.
fixture="ghp_$(printf '%s' '68340474a7569627df1bc9cb9f6d9a4ce66a')"
printf 'token = "%s"\n' "$fixture" > secret.txt
git add secret.txt
printf 'ordinary text\n' > secret.txt
expect_status 1 bash scripts/gitleaks.sh --staged
if grep -Fq "$fixture" "$temporary/output"; then echo 'Secret leaked into output.' >&2; exit 1; fi
# Clean staged content must not be confused with a later unstaged edit.
git add secret.txt
printf 'token = "%s"\n' "$fixture" > secret.txt
expect_status 0 bash scripts/gitleaks.sh --staged
printf 'secret.txt\n' > .gitignore
git add .gitignore
git add -f secret.txt
expect_status 1 bash scripts/gitleaks.sh --staged
# An inline suppression must not disable the repository gate.
printf 'api_key = "%s" # gitleaks:allow\n' "${fixture#ghp_}" > generic.txt
git add generic.txt
git rm --cached -q secret.txt
expect_status 1 bash scripts/gitleaks.sh --staged
git add -f secret.txt
git commit -qm 'test: synthetic detection fixture'
bad="$(git rev-parse HEAD)"
git rm -q secret.txt generic.txt
git commit -qm 'test: remove synthetic fixture'
head="$(git rev-parse HEAD)"
expect_status 0 bash scripts/gitleaks.sh --staged
expect_status 1 bash scripts/gitleaks.sh --history
printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" > "$temporary/push"
expect_status 1 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
zero=0000000000000000000000000000000000000000
printf 'refs/heads/new %s refs/heads/new %s\n' "$head" "$zero" > "$temporary/push"
expect_status 1 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
printf '(delete) %s refs/heads/old %s\n' "$zero" "$bad" > "$temporary/push"
expect_status 0 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$bad" > "$temporary/push"
expect_status 0 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
# A clean first ref must not hide a secret in a second ref.
printf 'refs/heads/clean %s refs/heads/clean %s\nrefs/heads/bad %s refs/heads/bad %s\n' \
  "$base" "$zero" "$head" "$zero" > "$temporary/push"
expect_status 1 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
printf 'refs/heads/main %s refs/heads/main %s\n' "$head" 'ffffffffffffffffffffffffffffffffffffffff' > "$temporary/push"
expect_status 1 bash scripts/gitleaks.sh --pre-push < "$temporary/push"
git clone --quiet --depth=1 "file://$temporary/repository" "$temporary/shallow"
expect_status 2 bash "$temporary/shallow/scripts/gitleaks.sh" --history
expect_status 2 bash scripts/gitleaks.sh --unknown
mkdir "$temporary/no-gitleaks"
ln -s "$(command -v dirname)" "$temporary/no-gitleaks/dirname"
expect_status 2 env XDG_CACHE_HOME="$temporary/missing" PATH="$temporary/no-gitleaks" "$BASH" scripts/gitleaks.sh --staged
mkdir "$temporary/bin"
printf '#!/bin/sh\necho 0.0.0\n' > "$temporary/bin/gitleaks"
chmod +x "$temporary/bin/gitleaks"
expect_status 2 env XDG_CACHE_HOME="$temporary/missing" PATH="$temporary/bin:$PATH" bash scripts/gitleaks.sh --staged
cp "$root/scripts/install-gitleaks.sh" scripts/
cat > "$temporary/bin/curl" <<'FIXTURE'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; printf 'invalid archive' > "$1"; exit 0; fi
  shift
done
exit 1
FIXTURE
chmod +x "$temporary/bin/curl"
expect_status 2 env XDG_CACHE_HOME="$temporary/missing" PATH="$temporary/bin:$PATH" bash scripts/install-gitleaks.sh
echo 'Gitleaks regression checks passed.'
