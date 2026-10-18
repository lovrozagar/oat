import { coverageByCheck } from "../../report/render/coverage.ts"
import type { ReportInput } from "../../report/render/input.ts"
import { renderConsole } from "../../report/render/summary.ts"
import type { ParserResult } from "../harness/result.ts"

/**
 * A skip on one entity must not look like the check never ran.
 *
 * Multi-entity labs made this lie: invalidate ran on every child and the console still said
 * "did not apply" because the parents skipped it.
 */
export function runCoverageReportSuite(): ParserResult[] {
	const input = {
		checksRun: ["invalidation.declared-route-changes", "list.read-after-write"],
		checksSkipped: [
			{ check: "invalidation.declared-route-changes", entity: "parent", needs: "a foreign read route" },
			{ check: "async.reaches-terminal-state", entity: "parent", needs: "x-async" },
			{ check: "async.reaches-terminal-state", entity: "child", needs: "x-async" },
		],
		checksSuppressed: [],
		client: { transcript: [] },
		durationMs: 1,
		entitiesTested: ["parent", "child"],
		findings: [],
	} as unknown as ReportInput

	const coverage = coverageByCheck(input)
	const text = renderConsole(input)
	const cases: Array<[string, string, boolean]> = [
		[
			"invalidate is partial, not never",
			"it ran on the child",
			coverage.partialSkip.some((r) => r.check === "invalidation.declared-route-changes"),
		],
		[
			"async never applied",
			"neither entity had x-async",
			coverage.never.some((r) => r.check === "async.reaches-terminal-state"),
		],
		[
			"console does not put a ran check under DID NOT APPLY",
			"the invalidate line lives in APPLIED ONLY ON SOME ENTITIES",
			text.includes("APPLIED ONLY ON SOME ENTITIES") &&
				text.slice(0, text.indexOf("APPLIED ONLY ON SOME ENTITIES")).includes("invalidation") === false,
		],
	]
	return cases.map(([name, why, ok]) => ({
		detail: String(ok),
		name,
		ok,
		why,
	}))
}
