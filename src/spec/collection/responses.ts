/** What an operation's documented success responses say: the JSON schema it answers with, and whether it streams. */

import type { OperationObject, SchemaObject } from "../types.ts"

export function successSchema(op: OperationObject): SchemaObject | null {
	const responses = op.responses ?? {}
	for (const code of ["200", "201", "202", "2XX", "default"]) {
		const content = responses[code]?.content
		if (content === undefined) continue
		for (const [mediaType, media] of Object.entries(content)) {
			if (!mediaType.includes("json")) continue
			if (media.schema !== undefined) return media.schema
		}
	}
	return null
}

const isSuccess = (code: string): boolean => code === "2XX" || code === "default" || /^2\d\d$/.test(code)

/** True when a success response lists `text/event-stream`. That media type is the stream tag. */
export function documentsEventStream(op: OperationObject): boolean {
	const responses = op.responses ?? {}
	for (const [code, response] of Object.entries(responses)) {
		if (!isSuccess(code)) continue
		const content = response?.content
		if (content === undefined) continue
		if (Object.keys(content).some((mediaType) => mediaType.includes("text/event-stream"))) return true
	}
	return false
}
