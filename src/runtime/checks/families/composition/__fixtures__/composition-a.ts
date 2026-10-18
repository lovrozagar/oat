import type { Record_ } from "../../../../world.ts"
import type { Responder } from "../../../__fixtures__/harness.ts"
import { answer, backend, NOTES, PARAMS, PATH, queryDoc, queryOf, REJECT } from "./query-api.ts"

/*
 * Defects for the composition checks: a backend that drops one parameter once others join it,
 * one that pages before it filters, one that never ends a walk, and one that refuses a mix.
 */

/** The notes document with a page parameter, so a set is read as a walk of pages. */
export const PAGED = queryDoc({}, [...PARAMS, "page"])

const holds = (query: Record<string, string>, present: readonly string[]): boolean =>
	present.every((name) => query[name] !== undefined)

/** The backend with `param` dropped whenever every parameter in `present` is in the query. */
export function dropping(param: string, present: readonly string[], respond: Responder = backend()): Responder {
	return (method, path, options) => {
		const query = queryOf(options)
		if (holds(query, present)) delete query[param]
		return respond(method, path, { ...options, query })
	}
}

/** A 400 whenever every parameter in `present` is in the query; the correct answer otherwise. */
export function rejecting(present: readonly string[], respond: Responder = backend()): Responder {
	return (method, path, options) => (holds(queryOf(options), present) ? REJECT : respond(method, path, options))
}

/** The page parameter ignored: every page is the first, so a walk never shows the set ended. */
export function ignoringPage(respond: Responder = backend()): Responder {
	return (method, path, options) => {
		const { page: _page, ...query } = queryOf(options)
		return respond(method, path, { ...options, query })
	}
}

/** The page window cut from the whole collection first and the filter applied to what it held. */
export function filterAfterPaging(rows: readonly Record_[] = NOTES): Responder {
	return (method, path, options) => {
		if (method !== "GET" || path !== PATH) return undefined
		const { filter, ...query } = queryOf(options)
		const page = answer(rows, query, [...PARAMS, "page"])
		return filter === undefined ? page : answer(page.body as Record_[], { filter }, ["filter"])
	}
}

/**
 * The correct backend until `calls` requests have been answered, then `after` — a collection
 * another writer moves under the check, or a backend that stops answering.
 */
export function switchingAfter(calls: number, after: Responder, before: Responder = backend()): Responder {
	let answered = 0
	return (method, path, options) => {
		answered += 1
		return answered <= calls ? before(method, path, options) : after(method, path, options)
	}
}

/** The correct answer, less its first row, whenever every parameter in `present` is in the query. */
export function losingFirstWhen(present: readonly string[], respond: Responder = backend()): Responder {
	return (method, path, options) => {
		const answered = respond(method, path, options)
		if (answered === undefined || !holds(queryOf(options), present)) return answered
		return { ...answered, body: (answered.body as Record_[]).slice(1) }
	}
}

/** The correct answer with every record's identity left out whenever `present` are all in the query. */
export function withoutIdentityWhen(present: readonly string[], respond: Responder = backend()): Responder {
	return (method, path, options) => {
		const answered = respond(method, path, options)
		if (answered === undefined || !holds(queryOf(options), present)) return answered
		return { ...answered, body: (answered.body as Record_[]).map(({ id: _id, ...rest }) => rest) }
	}
}
