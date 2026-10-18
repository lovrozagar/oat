import type { Record_ } from "../../../../world/records.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"
import { applySelect, backend, NOTES, queryOf } from "../../composition/__fixtures__/query-api.ts"

/*
 * Defective listings for the search and select checks: the correct notes backend with one
 * parameter dropped or answered wrongly, so each test plants exactly the defect it is about.
 */

/** The backend with `param` dropped from every request: accepted, and ignored. */
export function ignoring(param: string, rows: readonly Record_[] = NOTES): Responder {
	return (method, path, options) => {
		const { [param]: _dropped, ...rest } = queryOf(options)
		return backend(rows)(method, path, { query: rest })
	}
}

/** The backend, except that a request whose `param` is `value` gets `answer`. */
export function answering(param: string, value: string, answer: Answer): Responder {
	return (method, path, options) => (queryOf(options)[param] === value ? answer : backend(NOTES)(method, path, options))
}

/** A paged listing that serves the same page whatever page is asked for: no read is ever complete. */
export const notPaging: Responder = ignoring("page")

/** Case-sensitive free-text search over titles. */
export const caseSensitive: Responder = (method, path, options) => {
	const { q: search, ...rest } = queryOf(options)
	const rows = search === undefined ? NOTES : NOTES.filter((row) => String(row.title).includes(search))
	return backend(rows)(method, path, { query: rest })
}

/** The backend projecting as asked, then `edit` applied to every projected record. */
export function projecting(edit: (row: Record_) => Record_, rows: readonly Record_[] = NOTES): Responder {
	return (method, path, options) => {
		const { select, ...rest } = queryOf(options)
		const answer = backend(rows)(method, path, { query: rest })
		if (answer === undefined || select === undefined) return answer
		const projected = applySelect(answer.body as Record_[], select)
		return projected === null ? answer : { ...answer, body: projected.map(edit) }
	}
}
