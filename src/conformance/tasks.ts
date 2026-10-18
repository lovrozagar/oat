/*
 * The conformance pool's protocol: a task is a slice of a leg, small enough that the pool can
 * spread a long leg across its workers, and its answer is plain data the parent assembles and
 * prints in order. Every answer says how much memory its worker held after the task.
 */

import { writeHeapSnapshot } from "node:v8"
import { join } from "node:path"
import type { DefectName } from "../reference/defects.ts"
import { runScopeSuite } from "./scope.ts"
import { judgeShape, recallBehind, type ShapeCase, shapeReference } from "./shapes.ts"
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

async function answered(task: ConformanceTask): Promise<Unmeasured> {
	switch (task.kind) {
		case "baselines":
			return { kind: "leg", results: (await runBaselines(task.backend, task.dialect)).map(portableResult) }
		case "defects": {
			const results: CaseResult[] = []
			for (const defect of task.defects)
				results.push(portableResult(await judgeDefect(defect, task.backend, task.dialect)))
			return { kind: "leg", results }
		}
		case "shape-reference":
			return { checks: await shapeReference("memory"), kind: "reference" }
		case "shape":
			return { cases: [await judgeShape("memory", task.name, task.reference)], kind: "cases" }
		case "recall":
			return { cases: await recallBehind("memory", task.shape, task.defects), kind: "cases" }
		case "scope":
			return { kind: "results", results: await runScopeSuite(task.defects, task.known) }
	}
}

/**
 * Runs a task, then measures what the process holds. With `OAT_HEAP_SNAPSHOTS` set to a folder,
 * a heap snapshot is written there after each task: what a leg left behind is in the next one.
 */
export async function runTask(task: ConformanceTask, sequence: number): Promise<ConformanceAnswer> {
	const answer = await answered(task)
	const dir = process.env.OAT_HEAP_SNAPSHOTS
	if (dir !== undefined && dir !== "")
		writeHeapSnapshot(join(dir, `${process.pid}-${String(sequence).padStart(4, "0")}-${task.kind}.heapsnapshot`))
	const { heapUsed, rss } = process.memoryUsage()
	return { ...answer, memory: { heapUsed, rss } } as ConformanceAnswer
}
