#!/bin/sh
# Installs the `pst` binary from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/agentpersonality/personalitystore/main/install.sh | sh
#
# Options (environment variables):
#   PST_VERSION       release tag to install, e.g. v0.1.0 (default: latest)
#   PST_INSTALL_DIR   where to put `pst` (default: ~/.local/bin)
#   PST_REPO          GitHub repository (default: agentpersonality/personalitystore)
set -eu

REPO="${PST_REPO:-agentpersonality/personalitystore}"
VERSION="${PST_VERSION:-latest}"
INSTALL_DIR="${PST_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "pst install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); pst runs on macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
# A shell running under Rosetta on Apple silicon still gets the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
base="${PST_DOWNLOAD_BASE:-$base}"
asset="pst-$os-$arch"

command -v curl >/dev/null 2>&1 || fail "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($VERSION) from $REPO"
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "download failed: $base/checksums.txt"

expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "no checksum listed for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/pst"
echo "Installed $("$INSTALL_DIR/pst" --version) to $INSTALL_DIR/pst"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

cat <<'EOF'

Get started:
  pst init                  create your encrypted vault
  pst service install       run the vault service at login (macOS)
  pst connect claude        print the command that gives Claude Code access
  pst connect codex         same for Codex
  pst upgrade               update to the latest release later on
EOF
