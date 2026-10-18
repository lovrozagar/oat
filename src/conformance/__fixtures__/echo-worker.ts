/* A stand-in worker process: answers each task with the task itself, cloned both ways. */
process.on("message", (task) => process.send?.({ answer: task, ok: true }))
