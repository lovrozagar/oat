#!/usr/bin/env bash
# Standard verification. The grep deliberately keeps every diagnostic line — filtering to
# "recall|precision|✗" has hidden the cause of a failure four separate times.
cd "$(dirname "$0")/.." || exit 1
node --experimental-sqlite dist/cli.js conformance "$@" 2>&1 | grep -E \
  "hostile|── |recall|precision|diagnosed|✗|spurious:|missed|only .* check|did not run|left .* record|error:"
