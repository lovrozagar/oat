/** One conformance task per message, in a forked process; see `pool.ts`. */

import { messageOf } from "../errors/message.ts"
import { type ConformanceTask, runTask } from "./tasks.ts"

let sequence = 0

process.on("message", (task: ConformanceTask) => {
	sequence += 1
	runTask(task, sequence).then(
		(answer) => process.send?.({ answer, ok: true }),
		(error: unknown) =>
			process.send?.({ error: error instanceof Error ? (error.stack ?? error.message) : messageOf(error), ok: false }),
	)
})
