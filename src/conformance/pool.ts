/**
 * Conformance cases on worker processes.
 *
 * Every case already owns its server, so cases share nothing but the CPU — and the suite is
 * CPU-bound: oat and the reference backend run in one process, so concurrency inside it buys
 * nothing. Separate processes do, each with its own heap and event loop. A task is a slice of a
 * leg (see `tasks.ts`) and comes back as plain data the parent assembles and prints in order.
 * In process, the same tasks run one at a time in the caller's own process: for a test, or a
 * machine short of memory.
 */

import { availableParallelism } from "node:os"
import { type ChildProcess, fork } from "node:child_process"
import { type AnswerFor, type ConformanceAnswer, type ConformanceTask, runTask } from "./tasks.ts"
import { listening } from "./harness/launch.ts"

export type { AnswerFor, ConformanceAnswer, ConformanceTask, MemoryUse } from "./tasks.ts"

export interface ConformancePool {
	run<T extends ConformanceTask>(task: T): Promise<AnswerFor<T>>
	close(): Promise<void>
}

/** Threads used when `--jobs` is not given: most of the machine, never more than four. */
export function defaultJobs(): number {
	return Math.max(1, Math.min(4, availableParallelism() - 1))
}

/** A pool of `jobs` worker processes, or the caller's own process when `inProcess`. */
export function createPool(jobs: number, { inProcess = false }: { inProcess?: boolean } = {}): ConformancePool {
	if (inProcess) return inProcessPool()

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
		/* A worker answers each task with its own kind of answer: the IPC boundary is where that is trusted. */
		run: <T extends ConformanceTask>(task: T) =>
			new Promise<AnswerFor<T>>((resolve, reject) => {
				queue.push({ reject, resolve: resolve as (answer: ConformanceAnswer) => void, task })
				const worker = idle.shift()
				if (worker !== undefined) next(worker)
			}),
	}
}

/** Tasks run one at a time in this process, in the order they were asked for. */
function inProcessPool(): ConformancePool {
	let sequence = 0
	let previous: Promise<unknown> = Promise.resolve()
	return {
		close: async () => {
			await previous.catch(() => undefined)
		},
		run: <T extends ConformanceTask>(task: T) => {
			sequence += 1
			const turn = sequence
			const answer = previous.catch(() => undefined).then(() => runTask(task, turn, listening) as Promise<AnswerFor<T>>)
			previous = answer
			return answer
		},
	}
}
