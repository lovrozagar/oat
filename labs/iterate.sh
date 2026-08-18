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
	[ok-jobs]=""
	[bug-stale]="invalidation.declared-route-changes"
	[bug-nofilter]="filter.equality-selects-exactly-one"
	[bug-leak]="tenant.item-not-readable-cross-tenant"
	[bug-overclaim]="spec.declared-filterable-is-filterable"
	[bug-pagefilter]="query.filter-selects-from-whole-set"
	[bug-cursor]="pagination.cursor-agrees-with-page"
	[bug-lostupdate]="concurrency.no-lost-update"
	[bug-invite]="auth.invite-grants-then-revokes"
	[bug-tombstone]="softdelete.absent-from-default-list"
	[bug-rank]="auth.rank-is-monotonic"
	[bug-filterleak]="tenant.filter-does-not-bypass-scope"
	[bug-hasmore]="pagination.has-more-is-accurate"
	[bug-maxlimit]="pagination.limit-respects-documented-max"
	[bug-search]="search.q-narrows-result"
	[bug-select]="select.projection-honoured"
	[bug-sort]="sort.order-is-applied"
	[bug-idem]="idempotency.replay-does-not-duplicate"
	[bug-immutable]="patch.immutable-field-rejected"
	[bug-enum]="validation.enum-enforced"
	[bug-maxlen]="validation.max-length-enforced"
	[bug-required]="validation.required-enforced"
	[bug-revoke]="auth.invite-grants-then-revokes"
	[bug-offset]="pagination.page-walk-covers-set"
	[bug-oracle]="tenant.denial-does-not-reveal-existence"
	[bug-like]="filter.like-metacharacters-escaped"
	[bug-async]="async.reaches-terminal-state"
	[bug-effect]="effects.declared-effect-occurs"
	[bug-oversort]="spec.declared-sortable-is-sortable"
	[bug-overselect]="spec.declared-selectable-is-selectable"
	[bug-receipt]="async.receipt-identifies-the-job"
	[bug-count]="count.consistent-with-returned-page"
	[bug-widen]="patch.minimality"
	[bug-unknown]="filter.unknown-field-rejected"
	[bug-neq]="filter.negation-partitions-the-set"
	[bug-and]="filter.and-composes-as-intersection"
	[bug-or]="filter.or-composes-as-union"
	[bug-numeric]="filter.numeric-comparison-is-numeric"
	[bug-limit]="pagination.limit-bounds-page-size"
	[bug-dropfield]="create.persists-submitted-fields"
	[bug-status]="create.status-matches-document"
	[bug-del404]="delete.absent-record-returns-404"
	[bug-ctype]="validation.content-type-enforced"
	[bug-500]="error.malformed-filter-not-5xx"
	[bug-errschema]="schema.error-response-matches-document"
)

NEW_CASES=(
	ok-jobs
	bug-tombstone bug-rank bug-filterleak bug-hasmore bug-maxlimit
	bug-search bug-select bug-sort bug-idem bug-immutable
	bug-enum bug-maxlen bug-required bug-revoke bug-offset
	bug-oracle bug-like bug-async bug-effect
	bug-oversort bug-overselect bug-receipt bug-count bug-widen
	bug-unknown bug-neq bug-and bug-or bug-numeric bug-limit
	bug-dropfield bug-status bug-del404 bug-ctype bug-500 bug-errschema
)
OLD_CASES=(ok-pair ok-classic bug-stale bug-nofilter bug-leak bug-overclaim bug-pagefilter bug-cursor bug-lostupdate bug-invite)

if [ "${1:-}" = "cases" ]; then
	worlds=("${OLD_CASES[@]}" "${NEW_CASES[@]}")
elif [ "${1:-}" = "new" ]; then
	worlds=("${NEW_CASES[@]}")
elif [ "$#" -gt 0 ]; then
	worlds=("$@")
else
	worlds=(tiny "${OLD_CASES[@]}" "${NEW_CASES[@]}")
fi

node --experimental-strip-types labs/provision.mjs "${worlds[@]}"

port=${LAB_PORT_BASE:-8790}
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
	out=".oat/runs/labs/${world}"
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
report = json.load(open(f"{out}/latest/oat-report.json"))
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
open(f"{out}/latest/verdict.txt","w").write(status + "\n")
if missing:
    sys.exit(2)
PY
	echo
done
exit $fail
