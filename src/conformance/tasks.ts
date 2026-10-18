/*
 * The conformance pool's protocol: a task is a slice of a leg, small enough that the pool can
 * spread a long leg across its workers, and its answer is plain data the parent assembles and
 * prints in order. Every answer says how much memory its worker held after the task.
 */

import { writeHeapSnapshot } from "node:v8"
import { join } from "node:path"
import type { DefectName } from "../reference/defects/table.ts"
import { runScopeSuite } from "./scope.ts"
import { judgeShape, recallBehind, type ShapeCase, shapeReference, shapeTarget } from "./shapes.ts"
import type { Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"
import { type CaseResult, judgeDefect, portableResult, runBaselines } from "./matrix/cases.ts"
import type { Backend } from "./matrix/engines.ts"

export type ConformanceTask =
	/* One leg in pieces: its baselines, and its defects a chunk at a time, so the longest leg no
	 * longer sets the wall time. */
	| { kind: "baselines"; backend: Backend; dialect: string }
	| { kind: "defects"; backend: Backend; dialect: string; defects: DefectName[] }
	/* The shapes: the default shape's checks first, then each shape on its own. */
	| { kind: "shape-reference" }
	| { kind: "shape"; name: string; reference: string[] | null }
	/* Recall behind one shape, a chunk of defects at a time. */
	| { kind: "recall"; shape: string; defects: DefectName[] }
	| { kind: "scope"; defects: string[]; known: Record<string, string[]> }

/** What a worker held after a task, in bytes. */
export interface MemoryUse {
	rss: number
	heapUsed: number
}

export type ConformanceAnswer = (
	| { kind: "cases"; cases: ShapeCase[] }
	| { kind: "leg"; results: CaseResult[] }
	| { kind: "results"; results: ParserResult[] }
	| { kind: "reference"; checks: string[] | null }
) & { memory: MemoryUse }

/** The answer a task gets. */
export type AnswerFor<T extends ConformanceTask> = Extract<
	ConformanceAnswer,
	{
		kind: T extends { kind: "shape" | "recall" }
			? "cases"
			: T extends { kind: "scope" }
				? "results"
				: T extends { kind: "shape-reference" }
					? "reference"
					: "leg"
	}
>

type Unmeasured = ConformanceAnswer extends infer A ? (A extends unknown ? Omit<A, "memory"> : never) : never

async function answered(task: ConformanceTask, via: Via): Promise<Unmeasured> {
	const shapes = shapeTarget("memory", via)
	switch (task.kind) {
		case "baselines": {
			const results = await runBaselines({ backend: task.backend, dialect: task.dialect, via })
			return { kind: "leg", results: results.map(portableResult) }
		}
		case "defects": {
			const results: CaseResult[] = []
			for (const defect of task.defects) {
				const target = { backend: task.backend, dialect: task.dialect, via }
				results.push(portableResult(await judgeDefect(defect, target)))
			}
			return { kind: "leg", results }
		}
		case "shape-reference":
			return { checks: await shapeReference(shapes), kind: "reference" }
		case "shape":
			return { cases: [await judgeShape(shapes, task.name, task.reference)], kind: "cases" }
		case "recall":
			return { cases: await recallBehind(shapes, task.shape, task.defects), kind: "cases" }
		case "scope":
			return { kind: "results", results: await runScopeSuite(via, task.defects, task.known) }
	}
}

/**
 * Runs a task, then measures what the process holds. With `OAT_HEAP_SNAPSHOTS` set to a folder,
 * a heap snapshot is written there after each task: what a leg left behind is in the next one.
 * `via` says how the reference is reached: the gate's workers reach it behind a socket.
 */
export async function runTask(task: ConformanceTask, sequence: number, via: Via): Promise<ConformanceAnswer> {
	const answer = await answered(task, via)
	const dir = process.env.OAT_HEAP_SNAPSHOTS
	if (dir !== undefined && dir !== "")
		writeHeapSnapshot(join(dir, `${process.pid}-${String(sequence).padStart(4, "0")}-${task.kind}.heapsnapshot`))
	const { heapUsed, rss } = process.memoryUsage()
	return { ...answer, memory: { heapUsed, rss } } as ConformanceAnswer
}
