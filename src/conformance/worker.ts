/** One conformance task per message, in a forked process; see `pool.ts`. */

import type { ConformanceAnswer, ConformanceTask } from "./pool.ts"
import { runScopeSuite } from "./scope.ts"
import { runShapeRecall, runShapeSuite } from "./shapes.ts"
import { judgeDefect, portableResult, runBaselines } from "./suite.ts"

async function answer(task: ConformanceTask): Promise<ConformanceAnswer> {
	if (task.kind === "baselines") {
		return { kind: "leg", results: (await runBaselines(task.backend, task.dialect)).map(portableResult) }
	}
	if (task.kind === "defects") {
		const results = []
		for (const defect of task.defects)
			results.push(portableResult(await judgeDefect(defect, task.backend, task.dialect)))
		return { kind: "leg", results }
	}
	if (task.kind === "scope") return { kind: "results", results: await runScopeSuite(task.defects, task.known) }
	if (task.kind === "shapes") return { cases: await runShapeSuite("memory"), kind: "cases" }
	return { cases: await runShapeRecall("memory", task.shapes), kind: "cases" }
}

process.on("message", (task: ConformanceTask) => {
	answer(task).then(
		(result) => process.send?.({ answer: result, ok: true }),
		(error: unknown) =>
			process.send?.({
				error: error instanceof Error ? (error.stack ?? error.message) : String(error),
				ok: false,
			}),
	)
})
