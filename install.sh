#!/usr/bin/env bash
# Install the hypotenuse CLI on macOS or Linux:
#   curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash
#
# HYPOTENUSE_INSTALL_DIR  where to put it (default /usr/local/bin)
# HYPOTENUSE_VERSION      a release to pin, e.g. 0.1.0 (default: the latest)
set -euo pipefail

REPO="arcadeai-labs/hypotenuse"
INSTALL_DIR="${HYPOTENUSE_INSTALL_DIR:-/usr/local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "error: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${HYPOTENUSE_VERSION:-}" ]; then
  TAG="v${HYPOTENUSE_VERSION#v}"
else
  echo "Fetching the latest release..."
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
fi
if [ -z "$TAG" ]; then
  echo "error: could not determine the latest release" >&2
  exit 1
fi

ASSET="hypotenuse-${os}-${arch}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Downloading hypotenuse ${TAG} (${os}/${arch})..."
curl -fsSL "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}" -o "$TMP"
chmod +x "$TMP"
# A downloaded binary carries macOS's quarantine flag, and Gatekeeper refuses
# to run an unsigned one that has it.
if [ "$os" = "darwin" ]; then xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true; fi

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/hypotenuse"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMP" "${INSTALL_DIR}/hypotenuse"
fi
trap - EXIT

echo "Installed ${INSTALL_DIR}/hypotenuse"
"${INSTALL_DIR}/hypotenuse" --version
