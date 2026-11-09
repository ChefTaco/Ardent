#!/usr/bin/env bash
# Install the reviewed upstream binary without a paid Action or elevated privileges.
set -euo pipefail
version=8.30.1
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_x64; checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux/aarch64|Linux/arm64) platform=linux_arm64; checksum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Darwin/x86_64) platform=darwin_x64; checksum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Darwin/arm64) platform=darwin_arm64; checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  *) echo 'Unsupported platform: install Gitleaks 8.30.1 manually on PATH.' >&2; exit 2 ;;
esac
cache="${XDG_CACHE_HOME:-$HOME/.cache}/hivemagnus-tools/gitleaks/$version"
if [[ -x "$cache/gitleaks" ]] && [[ "$("$cache/gitleaks" version)" == "$version" ]]; then
  echo "Gitleaks $version is installed."
  exit 0
fi
umask 077
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_${platform}.tar.gz" \
  --output "$temporary/archive.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary/archive.tar.gz")"
else
  actual="$(shasum -a 256 "$temporary/archive.tar.gz")"
fi
if [[ "${actual%% *}" != "$checksum" ]]; then
  echo 'Gitleaks archive checksum mismatch; refusing installation.' >&2
  exit 2
fi
tar -xzf "$temporary/archive.tar.gz" -C "$temporary" gitleaks
chmod 755 "$temporary/gitleaks"
[[ "$("$temporary/gitleaks" version)" == "$version" ]]
mkdir -p "$cache"
# Move on the destination filesystem so readers never see a partial executable.
candidate="$(mktemp "$cache/.gitleaks.XXXXXX")"
cp "$temporary/gitleaks" "$candidate"
chmod 755 "$candidate"
mv -f "$candidate" "$cache/gitleaks"
echo "Installed Gitleaks $version."
