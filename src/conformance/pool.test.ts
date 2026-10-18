import { EventEmitter, once } from "node:events"
import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { inProcess } from "./harness/launch.ts"
import { createPool, defaultJobs, forkWorker, type PoolWorker } from "./pool.ts"
import { serveTasks } from "./serve-tasks.ts"
import type { ConformanceTask } from "./tasks.ts"

/*
 * A worker the pool drives as it would a forked process. Tasks cross a real MessageChannel, cloned
 * both ways, to `serveTasks` on the other end, which runs them against the reference in process.
 * A deaf one takes tasks and never answers, so a test can fail or end it mid-task.
 */
class ChannelWorker extends EventEmitter implements PoolWorker {
	exitCode: number | null = null
	signalCode: string | null = null
	readonly sent: ConformanceTask[] = []
	readonly #channel = new MessageChannel()

	constructor(deaf = false) {
		super()
		const { port1, port2 } = this.#channel
		if (!deaf)
			serveTasks(
				{ on: (event, listener) => port2.on(event, listener), send: (reply) => port2.postMessage(reply) },
				inProcess,
			)
		port1.on("message", (reply) => this.emit("message", reply))
	}

	send(task: ConformanceTask): void {
		this.sent.push(task)
		this.#channel.port1.postMessage(task)
	}

	kill(): void {
		this.end(null, "SIGTERM")
	}

	end(code: number | null, signal: string | null): void {
		this.#channel.port1.close()
		this.#channel.port2.close()
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
	}
}

function workers(deaf = false): { spawned: ChannelWorker[]; spawn: () => ChannelWorker } {
	const spawned: ChannelWorker[] = []
	return { spawn: () => spawned[spawned.push(new ChannelWorker(deaf)) - 1] as ChannelWorker, spawned }
}

const nothing: ConformanceTask = { defects: ["NO_SUCH_DEFECT"], kind: "scope", known: {} }
const noShape: ConformanceTask = { kind: "shape", name: "no-such-shape", reference: null }

describe("defaultJobs", () => {
	it("uses most of the machine, never more than four", () => {
		expect(defaultJobs()).toBeGreaterThanOrEqual(1)
		expect(defaultJobs()).toBeLessThanOrEqual(4)
	})
})

describe("a pool of workers", () => {
	it("spreads tasks over its workers and hands a queued one to whichever frees up", async () => {
		const { spawn, spawned } = workers()
		const pool = createPool(2, { spawn })
		const answers = await Promise.all([pool.run(nothing), pool.run(nothing), pool.run(nothing)])
		expect(answers.map((answer) => [answer.kind, answer.results])).toEqual([
			["results", []],
			["results", []],
			["results", []],
		])
		expect(spawned.map((worker) => worker.sent.length).toSorted()).toEqual([1, 2])
		await pool.close()
		expect(spawned.map((worker) => worker.signalCode)).toEqual(["SIGTERM", "SIGTERM"])
	})

	it("rejects a task with the error its worker sent back, and keeps the worker", async () => {
		const { spawn, spawned } = workers()
		const pool = createPool(0, { spawn })
		await expect(pool.run(noShape)).rejects.toThrow(/^Error: no shape "no-such-shape"\n/)
		await expect(pool.run(nothing)).resolves.toMatchObject({ kind: "results" })
		expect(spawned).toHaveLength(1)
		await pool.close()
	})

	it("rejects the task a worker fails on", async () => {
		const { spawn, spawned } = workers(true)
		const pool = createPool(1, { spawn })
		const pending = pool.run(nothing)
		spawned[0]?.emit("error", new Error("channel closed"))
		await expect(pending).rejects.toThrow("channel closed")
		await pool.close()
	})

	it("rejects the task a worker exits during, by its signal or its code", async () => {
		const { spawn, spawned } = workers(true)
		const pool = createPool(2, { spawn })
		const killed = pool.run(nothing)
		const crashed = pool.run(nothing)
		spawned[0]?.end(null, "SIGKILL")
		spawned[1]?.end(1, null)
		await expect(killed).rejects.toThrow("conformance worker exited (SIGKILL) during a task")
		await expect(crashed).rejects.toThrow("conformance worker exited (1) during a task")
		await pool.close()
		expect(spawned.map((worker) => worker.signalCode)).toEqual(["SIGKILL", null])
	})
})

describe("an in-process pool", () => {
	it("runs tasks one at a time in order, past a failed one", async () => {
		const pool = createPool(4, { inProcess: true, via: inProcess })
		const failed = pool.run(noShape)
		const after = pool.run(nothing)
		await expect(failed).rejects.toThrow('no shape "no-such-shape"')
		await expect(after).resolves.toMatchObject({ kind: "results", results: [] })
		const last = pool.run(noShape)
		await expect(pool.close()).resolves.toBeUndefined()
		await expect(last).rejects.toThrow("no shape")
	})
})

describe("forkWorker", () => {
	it("forks a process that clones what crosses its channel, Maps included", async () => {
		const worker = forkWorker(new URL("./__fixtures__/echo-worker.ts", import.meta.url))
		const task = { defects: [], known: new Map([["a", ["op"]]]) } as unknown as ConformanceTask
		const replied = once(worker as unknown as EventEmitter, "message")
		worker.send(task)
		const [reply] = await replied
		expect(reply).toEqual({ answer: task, ok: true })
		const exited = once(worker as unknown as EventEmitter, "exit")
		worker.kill()
		await exited
		expect(worker.signalCode).toBe("SIGTERM")
	})
})
