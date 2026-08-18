#!/usr/bin/env bash
# Provision D1 + oat each labs world (not huge/vast — D1 latency makes those a day).
set -euo pipefail
cd "$(dirname "$0")/.."
bash labs/iterate.sh tiny shop campus platform
echo "done — .oat/runs/labs/{tiny,shop,campus,platform}"
