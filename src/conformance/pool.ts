/**
 * Conformance legs on worker threads.
 *
 * Every case already owns its server, so cases share nothing but the CPU — and the suite is
 * CPU-bound: oat and the reference backend run in one process, so concurrency inside it buys
 * nothing. Threads do. A task is a slice of a leg — a pass's baselines or a chunk of its defects,
 * the shape suite, or the recall cases behind one shape — and comes back as plain data the parent
 * assembles and prints in order.
 */

import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"
import type { ShapeCase } from "./shapes.ts"
import type { DefectName } from "../reference/defects.ts"
import type { Backend, CaseResult, ParserResult } from "./suite.ts"

export type ConformanceTask =
	/* One leg in pieces: its baselines, and its defects a chunk at a time, so the longest leg no
	 * longer sets the wall time. */
	| { kind: "baselines"; backend: Backend; dialect: string }
	| { kind: "defects"; backend: Backend; dialect: string; defects: DefectName[] }
	| { kind: "shapes" }
	| { kind: "recall"; shapes: ShapeCase[] }
	| { kind: "scope"; defects: string[]; known: Record<string, string[]> }

export type ConformanceAnswer =
	| { kind: "cases"; cases: ShapeCase[] }
	| { kind: "leg"; results: CaseResult[] }
	| { kind: "results"; results: ParserResult[] }

export interface ConformancePool {
	run(task: ConformanceTask): Promise<ConformanceAnswer>
	close(): Promise<void>
}

/** Threads used when `--jobs` is not given: most of the machine, never more than four. */
export function defaultJobs(): number {
	return Math.max(1, Math.min(4, availableParallelism() - 1))
}

export function createPool(jobs: number): ConformancePool {
	const script = new URL("./worker.js", import.meta.url)
	const idle: Worker[] = []
	const all: Worker[] = []
	const queue: Array<{
		task: ConformanceTask
		resolve: (answer: ConformanceAnswer) => void
		reject: (error: Error) => void
	}> = []

	const next = (worker: Worker): void => {
		const job = queue.shift()
		if (job === undefined) {
			idle.push(worker)
			return
		}
		const settle = (message: { ok: boolean; answer?: ConformanceAnswer; error?: string }): void => {
			worker.off("error", fail)
			if (message.ok && message.answer !== undefined) job.resolve(message.answer)
			else job.reject(new Error(message.error ?? "conformance worker failed"))
			next(worker)
		}
		const fail = (error: Error): void => {
			worker.off("message", settle)
			job.reject(error)
		}
		worker.once("message", settle)
		worker.once("error", fail)
		worker.postMessage(job.task)
	}

	for (let index = 0; index < Math.max(1, jobs); index++) {
		const worker = new Worker(script)
		all.push(worker)
		idle.push(worker)
	}

	return {
		close: async () => {
			await Promise.all(all.map((worker) => worker.terminate()))
		},
		run: (task) =>
			new Promise((resolve, reject) => {
				queue.push({ reject, resolve, task })
				const worker = idle.shift()
				if (worker !== undefined) next(worker)
			}),
	}
}
