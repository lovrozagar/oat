/**
 * Conformance suite: the measurement loop.
 *
 * For each injected defect, assert oat reports exactly the check that defect should trip — and
 * for the clean baseline, assert it reports nothing at all. The baseline is the harder bar: a
 * tool that cries wolf on a correct backend is worse than no tool.
 *
 * Adding a check to oat means adding a defect here and expecting it. That keeps "smart" honest.
 */

import { DEFECTS, type DefectName } from "../reference/defects.ts"
import { createReferenceServer } from "../reference/server.ts"
import type { Finding } from "../runtime/finding.ts"
import { type PrincipalSpec, run } from "../runtime/run.ts"

/**
 * Which check each defect must trip.
 *
 * The first id is the primary — the diagnosis oat is required to reach. Any further ids are
 * *acceptable* consequences: one defect can legitimately violate several properties at once, and
 * calling those false positives would push oat toward under-reporting real problems.
 */
export const EXPECTED: Record<DefectName, string | string[]> = {
	CREATED_201_AS_200: "create.status-matches-document",
	CROSS_TENANT_READ: "tenant.item-not-readable-cross-tenant",
	COUNT_IGNORES_FILTER: "count.matches-filtered-set",
	CURSOR_DRIFT: "pagination.cursor-agrees-with-page",
	DELETE_MISSING_OK: "delete.absent-record-returns-404",
	ERROR_500_ON_BAD_FILTER: "error.malformed-filter-not-5xx",
	FILTER_IGNORED: "filter.unknown-field-rejected",
	IMMUTABLE_WRITABLE: "patch.immutable-field-rejected",
	LIKE_UNESCAPED: "filter.like-metacharacters-escaped",
	OFF_BY_ONE_PAGE: "pagination.page-walk-covers-set",
	PATCH_REPLACES: "patch.minimality",
	SELECT_IGNORED: "select.projection-honoured",
	SOFT_DELETE_LEAK: "softdelete.absent-from-default-list",
	STALE_LIST: "list.read-after-write",
	TENANT_LEAK_VIA_FILTER: "tenant.filter-does-not-bypass-scope",
	UNSTABLE_SORT: "pagination.page-walk-covers-set",
	LIMIT_IGNORED: "pagination.limit-bounds-page-size",
	LIMIT_EXCEEDS_MAX: "pagination.limit-respects-documented-max",
	HASMORE_ALWAYS_FALSE: "pagination.has-more-is-accurate",
	ORDER_IGNORED: "sort.order-is-applied",
	SEARCH_IGNORED: "search.q-narrows-result",
	CREATE_DROPS_FIELD: "create.persists-submitted-fields",
	ENUM_NOT_VALIDATED: "validation.enum-enforced",
	MAXLENGTH_NOT_VALIDATED: "validation.max-length-enforced",
	REQUIRED_NOT_VALIDATED: "validation.required-enforced",
	CONTENT_TYPE_NOT_ENFORCED: "validation.content-type-enforced",
	ERROR_SCHEMA_DRIFT: "schema.error-response-matches-document",
	RESPONSE_SCHEMA_DRIFT: "schema.success-response-matches-document",
	FILTER_EQ_NOT_APPLIED: [
		"filter.equality-selects-exactly-one",
		"filter.zero-match-returns-none",
		"filter.negation-partitions-the-set",
		"count.matches-filtered-set",
		"filter.like-metacharacters-escaped",
	],
	EMPTY_RESULT_RETURNS_ALL: [
		"filter.zero-match-returns-none",
		"filter.unknown-field-rejected",
		"filter.like-metacharacters-escaped",
	],
	NEQ_DROPS_NULLS: "filter.negation-partitions-the-set",
	SORT_DESC_DROPS_NULLS: "sort.reverse-symmetry",
}

function primaryOf(expected: string | string[]): string {
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

function acceptableOf(expected: string | string[]): string[] {
	return Array.isArray(expected) ? expected : [expected]
}

const PRINCIPALS: PrincipalSpec[] = [
	{
		acquire: { body: { key: "key_alpha" }, credentialFrom: "$.access_token", operationId: "auth.token" },
		id: "alpha",
		roots: { project_id: "proj_alpha" },
	},
	{
		acquire: { body: { key: "key_beta" }, credentialFrom: "$.access_token", operationId: "auth.token" },
		id: "beta",
		roots: { project_id: "proj_beta" },
	},
]

export interface CaseResult {
	label: string
	defect: DefectName | null
	expected: string | null
	detected: boolean
	/** Findings unrelated to the injected defect — false positives. */
	spurious: Finding[]
	findings: Finding[]
	entitiesTested: string[]
	/** Checks that actually executed. A clean run that ran nothing is not a pass. */
	checksRun: string[]
	/** Checks this defect may legitimately trip, primary first. */
	acceptable?: string[]
	error?: string
}

async function runAgainst(
	defects: DefectName[],
	untagged = false,
): Promise<{ findings: Finding[]; entitiesTested: string[]; checksRun: string[] }> {
	const backend = await createReferenceServer({ defects, untagged })
	try {
		const result = await run({
			baseUrl: backend.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${backend.url}/v1/openapi/spec`,
		})
		return {
			checksRun: result.checksRun,
			entitiesTested: result.entitiesTested,
			findings: result.findings,
		}
	} finally {
		await backend.close()
	}
}

export async function runSuite(filter?: string[]): Promise<CaseResult[]> {
	const results: CaseResult[] = []

	/* Baseline first — everything downstream is meaningless if this is not clean. */
	try {
		const { findings, entitiesTested, checksRun } = await runAgainst([])
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			checksRun,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			acceptable: [],
			label: "baseline (correct backend)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: error instanceof Error ? error.message : String(error),
			expected: null,
			findings: [],
			label: "baseline (correct backend)",
			spurious: [],
		})
	}

	/* The same baseline with every meta tag stripped. oat must still be quiet on a correct
	 * backend when it is running on heuristics alone — a fallback that invents findings would
	 * make the tool unusable on any spec that has not been annotated yet. */
	try {
		const { findings, entitiesTested, checksRun } = await runAgainst([], true)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			checksRun,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			acceptable: [],
			label: "baseline (untagged spec)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: error instanceof Error ? error.message : String(error),
			expected: null,
			findings: [],
			label: "baseline (untagged spec)",
			spurious: [],
		})
	}

	const names = (Object.keys(DEFECTS) as DefectName[]).filter(
		(name) => filter === undefined || filter.length === 0 || filter.includes(name),
	)

	for (const defect of names) {
		const expected = EXPECTED[defect]
		try {
			const { findings, entitiesTested, checksRun } = await runAgainst([defect])
			const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
			const acceptable = acceptableOf(expected)
			results.push({
				acceptable,
				checksRun,
				defect,
				detected: real.some((f) => f.check === primaryOf(expected)),
				entitiesTested,
				expected: primaryOf(expected),
				findings,
				label: defect,
				spurious: real.filter((f) => !acceptable.includes(f.check)),
			})
		} catch (error) {
			results.push({
				checksRun: [],
				defect,
				detected: false,
				entitiesTested: [],
				error: error instanceof Error ? error.message : String(error),
				acceptable: acceptableOf(expected),
				expected: primaryOf(expected),
				findings: [],
				label: defect,
				spurious: [],
			})
		}
	}

	return results
}

export function renderSuite(results: CaseResult[]): { text: string; failures: number } {
	const lines: string[] = []
	let failures = 0

	lines.push("")
	lines.push("  defect                     detected  spurious  expected check")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")

	/* A baseline that reports nothing because it ran nothing is not evidence of precision. */
	const MIN_CHECKS = 10

	for (const result of results) {
		const isBaseline = result.defect === null
		const vacuous = isBaseline && result.checksRun.length < MIN_CHECKS
		const ok = isBaseline
			? result.spurious.length === 0 && !vacuous
			: result.detected && result.spurious.length === 0
		if (!ok) failures++

		const mark = ok ? "✓" : "✗"
		const detected = isBaseline
			? vacuous
				? "VACUOUS"
				: result.spurious.length === 0
					? "clean"
					: "noisy"
			: result.detected
				? "yes"
				: "NO"
		const coverage = isBaseline ? `${result.checksRun.length} checks` : (result.expected ?? "—")
		lines.push(
			`  ${mark} ${result.label.padEnd(26)} ${detected.padEnd(8)} ${String(result.spurious.length).padEnd(9)} ${coverage}`,
		)

		if (vacuous) {
			lines.push(
				`      only ${result.checksRun.length} check(s) ran against ${result.entitiesTested.length} ` +
					"entity/entities — a silent run proves nothing",
			)
		}
		if (result.error !== undefined) lines.push(`      error: ${result.error}`)
		for (const finding of result.spurious.slice(0, 4)) {
			lines.push(`      spurious: [${finding.check}] ${finding.summary}`)
		}
		if (!isBaseline && !result.detected && result.error === undefined) {
			const others = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP")
			lines.push(
				`      missed — reported instead: ${others.map((f) => f.check).join(", ") || "nothing"}`,
			)
		}
	}

	const cases = results.length
	const detectionCases = results.filter((r) => r.defect !== null)
	const detected = detectionCases.filter((r) => r.detected).length
	const baseline = results.find((r) => r.defect === null)

	lines.push("")
	lines.push(
		`  recall     ${detected}/${detectionCases.length} injected defects detected`,
	)
	lines.push(
		`  precision  ${baseline?.spurious.length === 0 ? "clean baseline — no findings against a correct backend" : `${baseline?.spurious.length ?? 0} false positive(s) on the correct backend`}`,
	)
	lines.push(`  ${cases - failures}/${cases} cases passed`)
	lines.push("")

	/* Every check must be exercised by at least one defect. An unexercised check has never been
	 * shown to detect anything, so its passing tells you nothing. */
	const baselineChecks = results.find((r) => r.defect === null)?.checksRun ?? []
	const proven = new Set(
		results.filter((r) => r.detected).flatMap((r) => r.acceptable ?? [r.expected ?? ""]),
	)
	const unproven = baselineChecks.filter((id) => !proven.has(id))
	if (unproven.length > 0) {
		lines.push(`  ${unproven.length} check(s) run but never proven by an injected defect:`)
		for (const id of unproven) lines.push(`    ${id}`)
		lines.push("")
	}

	return { failures, text: lines.join("\n") }
}
