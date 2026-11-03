#!/bin/sh
# A stand-in for the `claude` CLI, baked into `hypotenuse/sandbox:test`.
# See stub-agent.ts beside it.
exec bun /usr/local/lib/hypotenuse/stub-agent.ts claude "$@"
