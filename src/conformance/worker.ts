/** One conformance leg per message; see `pool.ts`. */

import { parentPort } from "node:worker_threads"
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
