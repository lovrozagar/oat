import { once } from "node:events"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { inProcess, type Via } from "./harness/launch.ts"
import { serveTasks, type TaskReply } from "./serve-tasks.ts"
import type { ConformanceTask } from "./tasks.ts"

/*
 * The pool talks to a worker over a channel that clones each message, as a forked process's IPC
 * does with advanced serialization: a real MessageChannel stands in for it here.
 */

const open: MessagePort[] = []

afterEach(() => {
	for (const port of open.splice(0)) port.close()
})

/** A served channel: tasks go in at one end, replies come back out of it. */
function channel(via: Via): { ask: (task: ConformanceTask) => Promise<TaskReply> } {
	const { port1, port2 } = new MessageChannel()
	open.push(port1, port2)
	serveTasks({ on: (event, listener) => port2.on(event, listener), send: (reply) => port2.postMessage(reply) }, via)
	return {
		ask: async (task) => {
			port1.postMessage(task)
			const [reply] = (await once(port1, "message")) as [TaskReply]
			return reply
		},
	}
}

const nothing: ConformanceTask = { defects: ["NO_SUCH_DEFECT"], kind: "scope", known: {} }

describe("serveTasks", () => {
	it("answers each task over the channel, with what the worker held afterwards", async () => {
		const { ask } = channel(inProcess)
		const reply = await ask(nothing)
		expect(reply).toMatchObject({ answer: { kind: "results", results: [] }, ok: true })
		expect(reply.ok && reply.answer.memory.rss).toBeGreaterThan(0)
		expect(await ask(nothing)).toMatchObject({ ok: true })
	})

	it("sends back a failure's stack", async () => {
		const reply = await channel(inProcess).ask({ kind: "shape", name: "no-such-shape", reference: null })
		expect(reply).toEqual({ error: expect.stringMatching(/^Error: no shape "no-such-shape"\n\s+at /), ok: false })
	})
})
