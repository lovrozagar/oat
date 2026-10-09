/**
 * Conformance cases on worker processes.
 *
 * Every case already owns its server, so cases share nothing but the CPU — and the suite is
 * CPU-bound: oat and the reference backend run in one process, so concurrency inside it buys
 * nothing. Separate processes do, each with its own heap and event loop. A task is a slice of a leg — a pass's baselines or a chunk of its defects,
 * the shape suite, or the recall cases behind one shape — and comes back as plain data the parent
 * assembles and prints in order.
 */

import { availableParallelism } from "node:os"
import { type ChildProcess, fork } from "node:child_process"
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
	const idle: ChildProcess[] = []
	const all: ChildProcess[] = []
	const queue: Array<{
		task: ConformanceTask
		resolve: (answer: ConformanceAnswer) => void
		reject: (error: Error) => void
	}> = []

	const next = (worker: ChildProcess): void => {
		const job = queue.shift()
		if (job === undefined) {
			idle.push(worker)
			return
		}
		const settle = (message: unknown): void => {
			worker.off("error", fail)
			worker.off("exit", died)
			const reply = message as { ok: boolean; answer?: ConformanceAnswer; error?: string }
			if (reply.ok && reply.answer !== undefined) job.resolve(reply.answer)
			else job.reject(new Error(reply.error ?? "conformance worker failed"))
			next(worker)
		}
		const fail = (error: Error): void => {
			worker.off("message", settle)
			worker.off("exit", died)
			job.reject(error)
		}
		const died = (code: number | null, signal: string | null): void => {
			worker.off("message", settle)
			worker.off("error", fail)
			job.reject(new Error(`conformance worker exited (${signal ?? code}) during a task`))
		}
		worker.once("message", settle)
		worker.once("error", fail)
		worker.once("exit", died)
		worker.send(job.task)
	}

	for (let index = 0; index < Math.max(1, jobs); index++) {
		/* Structured clone, as between threads: results carry Maps and Sets. */
		const worker = fork(script, { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] })
		all.push(worker)
		idle.push(worker)
	}

	return {
		close: async () => {
			await Promise.all(
				all.map(
					(worker) =>
						new Promise<void>((resolve) => {
							if (worker.exitCode !== null || worker.signalCode !== null) return resolve()
							worker.once("exit", () => resolve())
							worker.kill()
						}),
				),
			)
		},
		run: (task) =>
			new Promise((resolve, reject) => {
				queue.push({ reject, resolve, task })
				const worker = idle.shift()
				if (worker !== undefined) next(worker)
			}),
	}
}
