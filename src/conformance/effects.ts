/**
 * Extract-shaped `x-effects`: one write creates a parent and appends a data-dependent child list.
 *
 * Nested observe must bind the new parent id (response `table_id` / identity, or the list delta).
 * `min` is at-least — empty child list fails, five rows pass. `count` + `min` is rejected at load.
 */

import { messageOf } from "../errors/message.ts"
import type { Finding } from "../runtime/finding.ts"
import { run, type RunResult } from "../runtime/run/index.ts"
import { buildModel } from "../spec/graph/build.ts"
import { readEffects } from "../spec/extensions/effects.ts"
import { GapCollector } from "../spec/extensions/gaps.ts"
import { extractBackend } from "./effects/backend.ts"
import { extractSpec } from "./effects/spec.ts"
import { listening, reach, type Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"

/** One run of oat against the extract backend, and what it should have found. */
interface ExtractCase {
	name: string
	why: string
	rowCount: number
	judge: (result: RunResult) => { ok: boolean; detail: string }
}

const DECLARED = "effects.declared-effect-occurs"

const isBug = (check: string) => (finding: Finding) => finding.check === check && finding.verdict === "BACKEND_BUG"

const CASES: readonly ExtractCase[] = [
	{
		judge: ({ findings }) => {
			const effectBug = findings.find(isBug(DECLARED))
			return {
				detail:
					effectBug === undefined
						? `no effect finding; findings=${findings.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}`
						: effectBug.detail,
				/* "row" in either text: the space between them cannot make one. */
				ok: effectBug !== undefined && `${effectBug.detail} ${effectBug.summary}`.includes("row"),
			}
		},
		name: "extract with an empty row list fails min: 1",
		rowCount: 0,
		why: "nested row list after table create must be observed",
	},
	{
		judge: ({ findings }) => {
			const effectBug = findings.find((finding) => finding.check === DECLARED)
			const waitBug = findings.find(isBug("effects.side-effect-arrives"))
			const ok = effectBug === undefined && waitBug === undefined
			return {
				detail: ok
					? "no effect/wait findings"
					: `effects=${effectBug?.detail ?? "none"}; wait=${waitBug?.detail ?? "none"}`,
				ok,
			}
		},
		name: "extract with 5 rows passes min: 1",
		rowCount: 5,
		why: "bound table_id must fill the nested row list and x-wait",
	},
]

/** `count` and `min` on one effect: dropped with a gap at load, while the suite's own `min` is kept. */
function contradictionCase(): ParserResult {
	const gaps = new GapCollector()
	const both = readEffects(
		{ responses: {}, "x-effects": [{ count: 1, entity: "row", min: 1, op: "append" }] } as never,
		"extract.once",
		gaps,
	)
	const effects = buildModel(extractSpec())
		.operations.filter((op) => op.operationId === "extract.once")
		.flatMap((op) => op.effects)
	return {
		detail: `read=${JSON.stringify(both)} gaps=${JSON.stringify(gaps.gaps)} modelled=${JSON.stringify(effects)}`,
		name: "count and min together are rejected at load",
		ok:
			both.length === 0 &&
			gaps.gaps.some((gap) => gap.tag === "x-effects" && gap.detail.includes("count and min")) &&
			effects.some((effect) => effect.entity === "row" && effect.min === 1 && effect.count === undefined),
		why: "doctor / readEffects must not keep a contradictory item",
	}
}

async function runExtract(via: Via, rowCount: number): Promise<RunResult> {
	const hosted = await via.host(extractBackend(rowCount))
	try {
		return await run({
			baseUrl: hosted.url,
			cohortSize: 1,
			only: ["table"],
			principals: { alpha: { scope: { project_id: "p1" }, tenant: "p1" } },
			security: { bearer: { static: "t" } },
			seed: 1,
			spec: `${hosted.url}/v1/openapi/spec`,
			...reach(hosted),
		})
	} finally {
		await hosted.close()
	}
}

export async function runEffectsSuite(via: Via = listening): Promise<ParserResult[]> {
	const results = [contradictionCase()]
	for (const { judge, name, rowCount, why } of CASES) {
		try {
			const { detail, ok } = judge(await runExtract(via, rowCount))
			results.push({ detail, name, ok, why })
		} catch (error) {
			results.push({ detail: messageOf(error), name, ok: false, why })
		}
	}
	return results
}
