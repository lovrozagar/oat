/**
 * Targeted-run recall: `--ops` must not lose a defect it was pointed at.
 *
 * For every defect the reference backend can exhibit, a full run names the operations its finding
 * judges. A run targeted at exactly those operations has to report the same defect. A check whose
 * declared `subjects` omit the operation it actually judges fails here: the targeted run either
 * never queues it or attributes the finding elsewhere.
 */

import { messageOf } from "../errors/message.ts"
import type { DefectName } from "../reference/defects/table.ts"
import type { Finding } from "../runtime/finding.ts"
import { run } from "../runtime/run/index.ts"
import { EXPECTED } from "./expected/table.ts"
import type { ParserResult } from "./harness/result.ts"
import { launch, reach, type Via } from "./harness/launch.ts"
import { defectsFor } from "./matrix/defects.ts"
import { judgedOperations, primaryOf } from "./matrix/expected.ts"
import { PRINCIPALS } from "./matrix/principals.ts"

const NOT_DEFECTS: ReadonlySet<string> = /* @__PURE__ */ new Set(["COVERAGE_GAP", "BLOCKED"])

async function runOnce(
	defects: DefectName[],
	ops: string[] | undefined,
	via: Via,
): Promise<{ findings: Finding[]; statuses: Map<string, string> }> {
	const server = await launch({ backend: "memory", dialect: "postgrest", via }, { defects })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...(ops === undefined ? {} : { ops }),
			...reach(server),
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
	via: Via,
	filter?: string[],
	known?: Readonly<Record<string, readonly string[]>>,
): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	/* What the default backend and dialect this suite targets can exhibit: a shape-only or
	 * dialect-only defect has nowhere to happen here. */
	const names = defectsFor("memory", "postgrest").filter(
		(name) => filter === undefined || filter.length === 0 || filter.includes(name),
	)

	for (const defect of names) {
		const check = primaryOf(EXPECTED[defect])
		const name = `--ops recall: ${defect}`
		const why = `a run targeted at the operation ${check} judges must still report it`
		try {
			const reported = known?.[defect]
			const fresh =
				reported === undefined
					? (await runOnce([defect], undefined, via)).findings.filter((f) => f.check === check)
					: []
			const ops: readonly string[] | undefined =
				reported ?? (fresh.length === 0 ? undefined : judgedOperations(fresh, check))
			if (ops === undefined) {
				results.push({ detail: "the full run did not report it either", name, ok: false, why })
				continue
			}
			if (ops.length === 0) {
				results.push({ detail: `${check} finding carries no operation`, name, ok: false, why })
				continue
			}
			const targeted = await runOnce([defect], [...ops], via)
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
			results.push({ detail: messageOf(error), name, ok: false, why })
		}
	}
	return results
}
