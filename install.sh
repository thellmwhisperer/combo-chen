#!/bin/sh
# install.sh - combo-chen tarball install channel.
#
# Installs a release archive under a versions prefix and links the CLI into a
# bin directory, producing the release_archive layout `combo-chen update`
# auto-replaces:
#
#   <prefix>/combo-chen-vX.Y.Z/bin/combo-chen   (extracted archive)
#   <bin-dir>/combo-chen -> that executable      (symlink owned by this script)
#
# Remote install (default) resolves the latest GitHub release, downloads the
# platform asset plus checksums.txt, and verifies the sha256 before touching
# anything. Local install (--archive/--checksums) verifies and installs a
# pre-downloaded pair; CI and the e2e suite use it to stay off the network.
#
# Safety contract: never overwrites an existing non-symlink bin target, never
# deletes previous version directories, and re-running is idempotent.
set -eu

REPO="thellmwhisperer/combo-chen"
PREFIX="${HOME}/.combo-chen/versions"
BIN_DIR="${HOME}/.local/bin"
VERSION=""
ARCHIVE=""
CHECKSUMS=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --version X.Y.Z    Install a specific release (default: latest).
  --repo OWNER/NAME  GitHub repository (default: thellmwhisperer/combo-chen).
  --prefix DIR       Versions prefix (default: ~/.combo-chen/versions).
  --bin-dir DIR      Symlink directory (default: ~/.local/bin).
  --archive FILE     Install from a local archive (requires --checksums).
  --checksums FILE   checksums.txt matching --archive.
  -h, --help         Show this help.
EOF
}

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --checksums) CHECKSUMS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *) fail "unsupported platform: $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "need sha256sum or shasum"
  fi
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/combo-chen-install.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -n "$ARCHIVE" ] || [ -n "$CHECKSUMS" ]; then
  [ -n "$ARCHIVE" ] && [ -n "$CHECKSUMS" ] || fail "--archive and --checksums must be used together"
  [ -f "$ARCHIVE" ] || fail "archive not found: $ARCHIVE"
  [ -f "$CHECKSUMS" ] || fail "checksums not found: $CHECKSUMS"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required for remote install"
  if [ -n "$VERSION" ]; then
    TAG="combo-chen-v${VERSION#v}"
  else
    TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
      sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
    [ -n "$TAG" ] || fail "could not resolve the latest release tag for ${REPO}"
  fi
  ASSET_NAME="${TAG}-${PLATFORM}-${ARCH}.tar.gz"
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  ARCHIVE="${WORK_DIR}/${ASSET_NAME}"
  CHECKSUMS="${WORK_DIR}/checksums.txt"
  echo "downloading ${ASSET_NAME}"
  curl -fsSL -o "$ARCHIVE" "${BASE_URL}/${ASSET_NAME}" || fail "download failed: ${BASE_URL}/${ASSET_NAME}"
  curl -fsSL -o "$CHECKSUMS" "${BASE_URL}/checksums.txt" || fail "download failed: ${BASE_URL}/checksums.txt"
fi

ASSET_NAME="$(basename "$ARCHIVE")"
case "$ASSET_NAME" in
  combo-chen-v*-"${PLATFORM}"-"${ARCH}".tar.gz) ;;
  *) fail "archive name '${ASSET_NAME}' does not match combo-chen-vX.Y.Z-${PLATFORM}-${ARCH}.tar.gz" ;;
esac
ARCHIVE_ROOT="${ASSET_NAME%-${PLATFORM}-${ARCH}.tar.gz}"

EXPECTED="$(awk -v name="$ASSET_NAME" '$2 == name { print $1 }' "$CHECKSUMS" | head -n1)"
[ -n "$EXPECTED" ] || fail "no checksum entry for ${ASSET_NAME}"
ACTUAL="$(sha256_of "$ARCHIVE")"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for ${ASSET_NAME}: expected ${EXPECTED}, got ${ACTUAL}"

INSTALL_DIR="${PREFIX}/${ARCHIVE_ROOT}"
if [ -x "${INSTALL_DIR}/bin/combo-chen" ]; then
  echo "already installed: ${INSTALL_DIR}"
else
  EXTRACT_DIR="${WORK_DIR}/extract"
  mkdir -p "$EXTRACT_DIR"
  tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"
  [ -f "${EXTRACT_DIR}/${ARCHIVE_ROOT}/bin/combo-chen" ] ||
    fail "archive is missing ${ARCHIVE_ROOT}/bin/combo-chen"
  mkdir -p "$PREFIX"
  rm -rf "${INSTALL_DIR}.partial"
  mv "${EXTRACT_DIR}/${ARCHIVE_ROOT}" "${INSTALL_DIR}.partial"
  mv "${INSTALL_DIR}.partial" "$INSTALL_DIR"
  echo "installed: ${INSTALL_DIR}"
fi

LINK="${BIN_DIR}/combo-chen"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  fail "refusing to overwrite non-symlink ${LINK}; remove it or pick another --bin-dir"
fi
mkdir -p "$BIN_DIR"
ln -sfn "${INSTALL_DIR}/bin/combo-chen" "$LINK"
echo "linked: ${LINK} -> ${INSTALL_DIR}/bin/combo-chen"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "note: ${BIN_DIR} is not on your PATH" ;;
esac
echo "done: run 'combo-chen --version' to verify, 'combo-chen update' to stay current"
