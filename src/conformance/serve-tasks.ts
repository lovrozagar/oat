/** A conformance worker's side of the pool: one task per message, each answered on the same channel. */

import type { Via } from "./harness/launch.ts"
import { type ConformanceAnswer, type ConformanceTask, runTask } from "./tasks.ts"

/** What a worker sends back for each task: its answer, or why it has none. */
export type TaskReply = { ok: true; answer: ConformanceAnswer } | { ok: false; error: string }

/** Where tasks arrive and replies go: a forked process's IPC channel, or anything shaped like it. */
export interface TaskPort {
	on(event: "message", listener: (task: ConformanceTask) => void): unknown
	/** Absent when nothing is listening: the task still runs, and its reply is dropped. */
	send?: ((reply: TaskReply) => unknown) | undefined
}

/** Runs each task `port` delivers, numbered in arrival order, reaching the reference by `via`. */
export function serveTasks(port: TaskPort, via: Via): void {
	let sequence = 0
	port.on("message", (task) => {
		sequence += 1
		runTask(task, sequence, via).then(
			(answer) => port.send?.({ answer, ok: true }),
			/* A task reports its own failures; only a malformed task or a failed heap snapshot rejects,
			 * always with an Error, and V8 gives every Error a stack. */
			(error: Error) => port.send?.({ error: String(error.stack), ok: false }),
		)
	})
}
