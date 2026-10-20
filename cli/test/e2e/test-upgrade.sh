#!/usr/bin/env bash
# The upgrade path, end to end: install the current branch three ways — npm,
# bun, and the compiled binary — and check that each reports this version, can
# check for updates, and detects how it was installed. From mcpx.
#
# Runs as the "CLI Upgrade" job in ci.yml and inside auto-release.yml's CI.
# Installs globally; run it in CI or a throwaway machine.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$CLI_DIR"

PASS=0
FAIL=0
ERRORS=""
EXPECTED_VERSION="$(jq -r .version package.json)"
BIN_DIR="${HYPOTENUSE_TEST_BIN_DIR:-/usr/local/bin}"

# Its own config directory, so the update cache it clears is never a person's.
export XDG_CONFIG_HOME="$(mktemp -d)"
export PATH="$HOME/.bun/bin:$PATH"
WORK="$(mktemp -d)"

pass() { PASS=$((PASS + 1)); echo "  ✔ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS+="  ✖ $1"$'\n'; echo "  ✖ $1"; }
clear_cache() { rm -f "$XDG_CONFIG_HOME/hypotenuse/update.json"; }

assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

assert_json_field() {
  local val
  val="$(echo "$2" | jq -r "$3 // empty")"
  if [ -n "$val" ]; then pass "$1"; else fail "$1 ($3 missing or empty)"; fi
}

# check_install <label> <expected method>
check_install() {
  local label="$1" method="$2" check upgrade
  hash -r
  assert_eq "$label: --version matches package.json" "$(hypotenuse --version)" "$EXPECTED_VERSION"

  clear_cache
  check="$(hypotenuse --json check-update 2>/dev/null)"
  assert_json_field "$label: check-update has currentVersion" "$check" ".currentVersion"
  assert_json_field "$label: check-update has latestVersion" "$check" ".latestVersion"
  assert_eq "$label: check-update currentVersion" "$(echo "$check" | jq -r .currentVersion)" "$EXPECTED_VERSION"

  clear_cache
  upgrade="$(hypotenuse --json upgrade 2>/dev/null || true)"
  assert_json_field "$label: upgrade has from" "$upgrade" ".from"
  assert_eq "$label: detected install method" "$(echo "$upgrade" | jq -r '.method // empty')" "$method"
}

echo "═══ packing @arcadeai/hypotenuse@$EXPECTED_VERSION ═══"
# `npm pack` runs prepack, which bundles dist/hypotenuse.js.
TARBALL="$WORK/$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)"
echo "  $TARBALL"

echo ""
echo "═══ 1: npm ═══"
npm install -g "$TARBALL"
check_install "npm" "npm"
npm uninstall -g @arcadeai/hypotenuse

echo ""
echo "═══ 2: bun ═══"
bun install -g "$TARBALL"
check_install "bun" "bun"
bun remove -g @arcadeai/hypotenuse

echo ""
echo "═══ 3: compiled binary ═══"
bun run build
if [ -w "$BIN_DIR" ]; then cp dist/hypotenuse "$BIN_DIR/hypotenuse"; else sudo cp dist/hypotenuse "$BIN_DIR/hypotenuse"; fi
check_install "binary" "binary"
if [ -w "$BIN_DIR" ]; then rm -f "$BIN_DIR/hypotenuse"; else sudo rm -f "$BIN_DIR/hypotenuse"; fi
hash -r

echo ""
echo "═══ RESULTS ═══"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo "$ERRORS"
  exit 1
fi
echo "All upgrade pathway tests passed."
