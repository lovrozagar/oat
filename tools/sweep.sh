#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
# BUILD GUARD — a sweep takes ~40 minutes and each config is a fresh node process, so rebuilding
# dist midway silently splits the run across two builds. Recording the fingerprint up front lets
# the end of the run prove every config saw the same code.
BUILD_AT=$(find dist -name '*.js' -newer package.json -exec stat -f '%m' {} + 2>/dev/null | sort -n | tail -1)
echo "### FUZZ"
for cfg in "memory postgrest 3001 10" "memory classic 4002 14" "sqlite postgrest 5003 12" "postgres postgrest 6004 10" "sqlite classic 7005 16" "sqlite postgrest 8888 20" "memory linked 9006 12" "memory jsonapi 9107 12" "memory plain 9208 12"; do
  set -- $cfg
  printf "%-9s %-10s seed=%-6s max=%-3s " "$1" "$2" "$3" "$4"
  # Keep the indented missed/spurious lines: collapsing to one line ate exactly the diagnostic
  # detail needed to act on a failure.
  node --experimental-sqlite dist/cli.js conformance --fuzz 150 --backend $1 --dialect $2 --seed $3 --max-defects $4 2>&1 | grep -E "diagnosed|✗|missed|spurious|run failed"
done
echo "### PRECISION"
for cfg in "memory postgrest 11" "sqlite postgrest 22" "memory classic 33" "postgres postgrest 44" "memory linked 55" "memory jsonapi 66" "memory plain 77"; do
  set -- $cfg
  printf "%-9s %-10s seed=%-4s " "$1" "$2" "$3"
  node --experimental-sqlite dist/cli.js conformance --precision 60 --backend $1 --dialect $2 --seed $3 2>&1 | grep -E "cohorts|✗|false positive|run failed"
done
NOW_AT=$(find dist -name '*.js' -newer package.json -exec stat -f '%m' {} + 2>/dev/null | sort -n | tail -1)
if [ "$BUILD_AT" != "$NOW_AT" ]; then
  echo "### INVALID — dist was rebuilt during this sweep; results span two builds"
fi
echo "### DONE"
