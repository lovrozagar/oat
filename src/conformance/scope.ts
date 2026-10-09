/**
 * Targeted-run recall: `--ops` must not lose a defect it was pointed at.
 *
 * For every defect the reference backend can exhibit, a full run names the operations its finding
 * judges. A run targeted at exactly those operations has to report the same defect. A check whose
 * declared `subjects` omit the operation it actually judges fails here: the targeted run either
 * never queues it or attributes the finding elsewhere.
 */

import { DEFECTS, type DefectName } from "../reference/defects.ts"
import type { Finding } from "../runtime/finding.ts"
import { run } from "../runtime/run.ts"
import { EXPECTED, PRINCIPALS, SQL_ONLY, type ParserResult } from "./suite.ts"

const NOT_DEFECTS = new Set(["COVERAGE_GAP", "BLOCKED"])

function primaryOf(expected: string | string[]): string {
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

async function runOnce(
	defects: DefectName[],
	ops?: string[],
): Promise<{ findings: Finding[]; statuses: Map<string, string> }> {
	const { createMemoryServer } = await import("../reference/http.ts")
	const server = await createMemoryServer({ defects })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...(ops === undefined ? {} : { ops }),
		})
		return {
			findings: result.findings.filter((f) => !NOT_DEFECTS.has(f.verdict)),
			statuses: new Map(result.scope.operations.map((op) => [op.operationId, op.status])),
		}
	} finally {
		await server.close()
	}
}

/**
 * `known` carries, per defect, the operations its finding judged in a full run the caller already
 * made — the defect matrix makes exactly that run — so only the targeted run is sent here.
 */
export async function runScopeSuite(
	filter?: string[],
	known?: Readonly<Record<string, readonly string[]>>,
): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	const names = (Object.keys(DEFECTS) as DefectName[])
		.filter((name) => filter === undefined || filter.length === 0 || filter.includes(name))
		.filter((name) => !SQL_ONLY.has(name))

	for (const defect of names) {
		const check = primaryOf(EXPECTED[defect])
		const name = `--ops recall: ${defect}`
		const why = `a run targeted at the operation ${check} judges must still report it`
		try {
			const reported = known?.[defect]
			const ops: readonly string[] | undefined =
				reported ?? (await runOnce([defect])).findings.find((f) => f.check === check)?.operations
			if (ops === undefined) {
				results.push({ detail: "the full run did not report it either", name, ok: false, why })
				continue
			}
			if (ops.length === 0) {
				results.push({ detail: `${check} finding carries no operation`, name, ok: false, why })
				continue
			}
			const targeted = await runOnce([defect], [...ops])
			const detected = targeted.findings.some((f) => f.check === check)
			const failed = ops.some((op) => targeted.statuses.get(op) === "failed")
			results.push({
				detail: `--ops ${ops.join(",")}: ${detected ? "reported" : "MISSED"}, status ${ops
					.map((op) => targeted.statuses.get(op) ?? "absent")
					.join(",")}`,
				name,
				ok: detected && failed,
				why,
			})
		} catch (error) {
			results.push({ detail: error instanceof Error ? error.message : String(error), name, ok: false, why })
		}
	}
	return results
}
