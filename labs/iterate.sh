#!/usr/bin/env bash
# Local loop: provision D1 → serve → oat. Stop on unexpected findings.
#
#   bash labs/iterate.sh                  # tiny + probe cases
#   bash labs/iterate.sh tiny shop campus
#   bash labs/iterate.sh cases
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .oatlogs
npm run build >/dev/null

declare -A EXPECT=(
	[tiny]=""
	[shop]=""
	[campus]=""
	[platform]=""
	[ok-pair]=""
	[ok-classic]=""
	[bug-stale]="invalidation.declared-route-changes"
	[bug-nofilter]="filter.equality-selects-exactly-one"
	[bug-leak]="tenant.item-not-readable-cross-tenant"
	[bug-overclaim]="spec.declared-filterable-is-filterable"
	[bug-pagefilter]="query.filter-selects-from-whole-set"
	[bug-cursor]="pagination.cursor-agrees-with-page"
	[bug-lostupdate]="concurrency.no-lost-update"
	[bug-invite]="auth.invite-grants-then-revokes"
)

if [ "${1:-}" = "cases" ]; then
	worlds=(ok-pair ok-classic bug-stale bug-nofilter bug-leak bug-overclaim bug-pagefilter bug-cursor bug-lostupdate bug-invite)
elif [ "$#" -gt 0 ]; then
	worlds=("$@")
else
	worlds=(tiny ok-pair ok-classic bug-stale bug-nofilter bug-leak bug-overclaim bug-pagefilter bug-cursor bug-lostupdate bug-invite)
fi

node --experimental-strip-types labs/provision.mjs "${worlds[@]}"

port=8790
fail=0
for world in "${worlds[@]}"; do
	port=$((port + 1))
	echo "── labs/${world} :${port}  (D1)"
	LAB="$world" LAB_PORT="$port" node --experimental-strip-types labs/serve.ts \
		>".oatlogs/labs-serve-${world}.log" 2>&1 &
	pid=$!
	cleanup() { kill "$pid" 2>/dev/null || true; }
	trap cleanup EXIT
	ready=0
	for _ in $(seq 1 80); do
		if curl -sf "http://127.0.0.1:${port}/v1/openapi/spec" >/dev/null; then ready=1; break; fi
		sleep 0.25
	done
	if [ "$ready" != 1 ]; then
		echo "  server never answered" >&2
		kill "$pid" 2>/dev/null || true
		trap - EXIT
		fail=1
		continue
	fi
	out="oat-out/labs/${world}"
	mkdir -p "$out" .oatlogs
	LAB_URL="http://127.0.0.1:${port}" node --experimental-sqlite dist/cli.js run \
		--config labs/oat.config.ts --out "$out" | tee ".oatlogs/labs-oat-${world}.log" || true
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	trap - EXIT

	python3 - "$world" "${EXPECT[$world]:-}" "$out" <<'PY' || fail=1
import json, sys
world, expect, out = sys.argv[1], sys.argv[2], sys.argv[3]
want = set(s for s in expect.split(",") if s)
report = json.load(open(f"{out}/oat-report.json"))
got = {f["check"] for f in report["findings"] if f["verdict"] not in ("COVERAGE_GAP", "BLOCKED")}
missing = sorted(want - got)
extra = sorted(got - want)
# Extra findings are consequences (drop-filter fires the whole filter family).
# Fail only when a required check is missing.
status = "FAIL" if missing else "ok"
print(f"  {status}  must {sorted(want) or '∅'}  got {sorted(got) or '∅'}")
if missing:
    print(f"    missing {missing}")
if extra:
    print(f"    also    {extra}")
open(f"{out}/verdict.txt","w").write(status + "\n")
if missing:
    sys.exit(2)
PY
	echo
done
exit $fail
