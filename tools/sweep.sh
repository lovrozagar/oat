#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
# BUILD GUARD — a sweep takes ~40 minutes and each config is a fresh node process, so rebuilding
# dist midway silently splits the run across two builds. A content fingerprint (not mtime, not
# BSD `stat -f`) is portable and actually changes when tsc rewrites a file.
BUILD_AT=$(find dist -name '*.js' | sort | cksum)
fail=0

# A config that cannot print a result line used to look like success: the prefix was printed
# and grep ate the error (Postgres auth failure, missing flag, crash). Empty output is a fail.
summarize() {
	local pattern=$1
	local out=$2
	local kept
	kept=$(printf '%s\n' "$out" | grep -E "$pattern" || true)
	if [ -n "$kept" ]; then
		printf '%s\n' "$kept"
		if printf '%s\n' "$kept" | grep -q '✗'; then
			fail=1
		fi
		return
	fi
	local err
	err=$(printf '%s\n' "$out" | grep -E '^oat:|error:|run failed' | tail -1)
	echo "✗ no result — ${err:-backend produced no suite output}"
	fail=1
}

echo "### FUZZ"
for cfg in "memory postgrest 3001 10" "memory classic 4002 14" "sqlite postgrest 5003 12" "postgres postgrest 6004 10" "sqlite classic 7005 16" "sqlite postgrest 8888 20" "memory linked 9006 12" "memory jsonapi 9107 12" "memory plain 9208 12"; do
	set -- $cfg
	printf "%-9s %-10s seed=%-6s max=%-3s " "$1" "$2" "$3" "$4"
	# Keep the indented missed/spurious lines: collapsing to one line ate exactly the diagnostic
	# detail needed to act on a failure.
	summarize "diagnosed|✗|missed|spurious|run failed" \
		"$(node --experimental-sqlite dist/cli.js conformance --fuzz 150 --backend $1 --dialect $2 --seed $3 --max-defects $4 2>&1)"
done
echo "### PRECISION"
for cfg in "memory postgrest 11" "sqlite postgrest 22" "memory classic 33" "postgres postgrest 44" "memory linked 55" "memory jsonapi 66" "memory plain 77"; do
	set -- $cfg
	printf "%-9s %-10s seed=%-4s " "$1" "$2" "$3"
	summarize "cohorts|✗|false positive|run failed" \
		"$(node --experimental-sqlite dist/cli.js conformance --precision 60 --backend $1 --dialect $2 --seed $3 2>&1)"
done
NOW_AT=$(find dist -name '*.js' | sort | cksum)
if [ "$BUILD_AT" != "$NOW_AT" ]; then
	echo "### INVALID — dist was rebuilt during this sweep; results span two builds"
	fail=1
fi
echo "### DONE"
exit "$fail"
