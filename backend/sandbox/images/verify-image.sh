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
claude --version
exit $status
'
