import type { SentResponder } from "./operation-context.ts"
import { NOTE_TARGET } from "./secured-api.ts"

/*
 * A broken backend that checks no credential and applies every write, a PATCH merged into the record
 * and any other write replacing it: what a refusal probe on a
 * write must survive. It holds the run-created note and one the run did not create, so a test shows
 * the probe touched only the first, and left it as it was.
 */

/** The note in the same project that the run did not create. */
export const FOREIGN_PATH = "/projects/proj_a/notes/n2"

const FOREIGN = { id: "n2", title: "not ours", verified: true }

/** The backend, and the records it holds by path, live. */
export function applyingBackend(): { respond: SentResponder; records: Map<string, unknown> } {
	const records = new Map<string, unknown>([
		[NOTE_TARGET.path, structuredClone(NOTE_TARGET.current)],
		[FOREIGN_PATH, structuredClone(FOREIGN)],
	])
	const respond: SentResponder = ({ method, options, path }) => {
		if (method === "DELETE") records.delete(path)
		else if (method === "PATCH" && records.has(path)) {
			records.set(path, { ...(records.get(path) as object), ...structuredClone(options.body as object) })
		} else if (method !== "GET" && records.has(path)) records.set(path, structuredClone(options.body))
		return { body: records.get(path) ?? null, status: 200 }
	}
	return { records, respond }
}

/** What the records hold when nothing was changed. */
export function untouched(): Map<string, unknown> {
	return new Map<string, unknown>([
		[NOTE_TARGET.path, NOTE_TARGET.current],
		[FOREIGN_PATH, FOREIGN],
	])
}
