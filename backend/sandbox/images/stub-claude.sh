#!/bin/sh
# A stand-in for the `claude` CLI, baked into `hypotenuse/sandbox:test`.
# See stub-claude.ts beside it.
exec bun /usr/local/lib/hypotenuse/stub-claude.ts "$@"
