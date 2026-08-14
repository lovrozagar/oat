#!/usr/bin/env bash
# Focused correct/buggy worlds on their own D1 databases.
set -euo pipefail
cd "$(dirname "$0")/.."
bash labs/iterate.sh cases
