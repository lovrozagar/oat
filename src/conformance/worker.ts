/** One conformance leg per message; see `pool.ts`. */

import { parentPort } from "node:worker_threads"
import type { ConformanceAnswer, ConformanceTask } from "./pool.ts"
import { runScopeSuite } from "./scope.ts"
import { runShapeRecall, runShapeSuite } from "./shapes.ts"
import { renderSuite, runSuite } from "./suite.ts"

async function answer(task: ConformanceTask): Promise<ConformanceAnswer> {
	if (task.kind === "pass") {
		const results = await runSuite(task.only, task.backend, task.dialect)
		const rendered = renderSuite(results, task.dialect, task.backend)
		const primaryOps: Record<string, string[]> = {}
		for (const result of results) {
			const finding = result.findings.find((item) => item.check === result.expected)
			if (result.defect !== null && finding?.operations !== undefined) primaryOps[result.defect] = finding.operations
		}
		return {
			baselines: { tagged: results[0]?.checksRun ?? [], untagged: results[1]?.checksRun ?? [] },
			failures: rendered.failures,
			kind: "pass",
			primaryOps,
			proven: [...rendered.proven],
			text: rendered.text,
		}
	}
	if (task.kind === "scope") return { kind: "results", results: await runScopeSuite(task.defects, task.known) }
	if (task.kind === "shapes") return { cases: await runShapeSuite("memory"), kind: "cases" }
	return { cases: await runShapeRecall("memory", task.shapes), kind: "cases" }
}

parentPort?.on("message", (task: ConformanceTask) => {
	answer(task).then(
		(result) => parentPort?.postMessage({ answer: result, ok: true }),
		(error: unknown) =>
			parentPort?.postMessage({
				error: error instanceof Error ? (error.stack ?? error.message) : String(error),
				ok: false,
			}),
	)
})
