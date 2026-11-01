#!/usr/bin/env bash
#
# Proves the userland `hypotenuse/sandbox:dev` promises is really there, by
# asking it as the user the agent runs as.
#
#   cd backend && bun run sandbox:verify-image
#   cd backend && bun run sandbox:verify-image -- some/other:image
set -euo pipefail

IMAGE="${1:-hypotenuse/sandbox:dev}"
REQUIRED_TOOLS="bun git curl jq node npm python3 gcc claude sudo"

docker run --rm --entrypoint /bin/sh -e REQUIRED_TOOLS="$REQUIRED_TOOLS" "$IMAGE" -c '
set -u
status=0
if [ "$(id -un)" != "agent" ]; then
  echo "runs as $(id -un), expected agent" >&2
  status=1
fi
for tool in $REQUIRED_TOOLS; do
  if path=$(command -v "$tool"); then
    echo "ok       $tool -> $path"
  else
    echo "MISSING  $tool" >&2
    status=1
  fi
done
[ "$(pwd)" = "/work" ] || { echo "working directory is $(pwd), expected /work" >&2; status=1; }
touch /work/.write-check && rm /work/.write-check || { echo "/work is not writable" >&2; status=1; }
sudo -n true || { echo "sudo -n failed" >&2; status=1; }
# The real GitHub CLI is off PATH; the managed wrapper is the only gh.
if [ -x /usr/local/lib/hypotenuse/gh-real ]; then
  echo "ok       gh-real -> $(/usr/local/lib/hypotenuse/gh-real --version | head -n 1)"
else
  echo "MISSING  /usr/local/lib/hypotenuse/gh-real" >&2
  status=1
fi
if command -v gh >/dev/null 2>&1; then
  echo "a stock gh is on PATH at $(command -v gh); only the managed wrapper may be" >&2
  status=1
fi
claude --version
exit $status
'
