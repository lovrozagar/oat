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
import { fork } from "node:child_process"
import { type AnswerFor, type ConformanceAnswer, type ConformanceTask, runTask } from "./tasks.ts"
import { listening, type Via } from "./harness/launch.ts"
import type { TaskReply } from "./serve-tasks.ts"

export type { AnswerFor, ConformanceAnswer, ConformanceTask, MemoryUse } from "./tasks.ts"

export interface ConformancePool {
	run<T extends ConformanceTask>(task: T): Promise<AnswerFor<T>>
	close(): Promise<void>
}

/** One worker as the pool drives it: a forked process, or anything that answers like one. */
export interface PoolWorker {
	send(task: ConformanceTask): unknown
	once(event: "message", listener: (reply: TaskReply) => void): unknown
	once(event: "error", listener: (error: Error) => void): unknown
	once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown
	off(event: "message", listener: (reply: TaskReply) => void): unknown
	off(event: "error", listener: (error: Error) => void): unknown
	off(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown
	kill(): unknown
	readonly exitCode: number | null
	readonly signalCode: string | null
}

export interface PoolOptions {
	/** Run every task in the caller's own process, one at a time. */
	inProcess?: boolean
	/** Starts one worker; a forked `worker.js` unless a test brings its own. */
	spawn?: () => PoolWorker
	/** How in-process tasks reach the reference: behind a socket, as the workers do, unless a test says otherwise. */
	via?: Via
}

interface Job {
	task: ConformanceTask
	resolve: (answer: ConformanceAnswer) => void
	reject: (error: Error) => void
}

/** Threads used when `--jobs` is not given: most of the machine, never more than four. */
export function defaultJobs(): number {
	return Math.max(1, Math.min(4, availableParallelism() - 1))
}

/** A worker process running `script`, the built `worker.js` beside this module by default. */
export function forkWorker(script: URL = new URL("./worker.js", import.meta.url)): PoolWorker {
	/* Structured clone, as between threads: results carry Maps and Sets. */
	return fork(script, { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] })
}

/** A pool of `jobs` worker processes, or the caller's own process when `inProcess`. */
export function createPool(
	jobs: number,
	{ inProcess = false, spawn = forkWorker, via = listening }: PoolOptions = {},
): ConformancePool {
	if (inProcess) return inProcessPool(via)
	return processPool(Array.from({ length: Math.max(1, jobs) }, () => spawn()))
}

/** Tasks handed to whichever worker is idle, in the order they were asked for. */
function processPool(workers: readonly PoolWorker[]): ConformancePool {
	const idle = [...workers]
	const queue: Job[] = []
	const next = (worker: PoolWorker): void => {
		const job = queue.shift()
		if (job === undefined) idle.push(worker)
		else assign(worker, job, next)
	}
	return {
		close: () => closeAll(workers),
		/* A worker answers each task with its own kind of answer: the IPC boundary is where that is trusted. */
		run: <T extends ConformanceTask>(task: T) =>
			new Promise<AnswerFor<T>>((resolve, reject) => {
				queue.push({ reject, resolve: resolve as (answer: ConformanceAnswer) => void, task })
				const worker = idle.shift()
				if (worker !== undefined) next(worker)
			}),
	}
}

/** Sends `job` to `worker` and settles it on whatever comes first: a reply (which frees the worker), an error, or an exit. */
function assign(worker: PoolWorker, job: Job, next: (worker: PoolWorker) => void): void {
	const settle = (reply: TaskReply): void => {
		worker.off("error", fail)
		worker.off("exit", died)
		if (reply.ok) job.resolve(reply.answer)
		else job.reject(new Error(reply.error))
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

/** Stops every worker still running, and waits for each to exit. */
async function closeAll(workers: readonly PoolWorker[]): Promise<void> {
	await Promise.all(
		workers.map(
			(worker) =>
				new Promise<void>((resolve) => {
					if (worker.exitCode !== null || worker.signalCode !== null) return resolve()
					worker.once("exit", () => resolve())
					worker.kill()
				}),
		),
	)
}

/** Tasks run one at a time in this process, in the order they were asked for. */
function inProcessPool(via: Via): ConformancePool {
	let sequence = 0
	let previous: Promise<unknown> = Promise.resolve()
	return {
		close: async () => {
			await previous.catch(() => undefined)
		},
		run: <T extends ConformanceTask>(task: T) => {
			sequence += 1
			const turn = sequence
			const answer = previous.catch(() => undefined).then(() => runTask(task, turn, via) as Promise<AnswerFor<T>>)
			previous = answer
			return answer
		},
	}
}
