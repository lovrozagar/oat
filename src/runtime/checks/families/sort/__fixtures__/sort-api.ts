import type { Record_ } from "../../../../world/records.ts"
import type { Responder } from "../../../__fixtures__/harness.ts"
import { backend, NOTES, PATH, queryOf, REJECT } from "../../composition/__fixtures__/query-api.ts"

/*
 * Backends for the sort family's tests, each one defect or one circumstance over the correct
 * notes backend: a parameter dropped, a collection that grows while a check reads it, a backend
 * that turns away every request after a number of them.
 */

/** The backend over `rows` with the query parameter `name` dropped before it answers. */
export function ignoring(name: string, rows: readonly Record_[] = NOTES): Responder {
	const serve = backend(rows)
	return (method, path, options) => {
		const { [name]: _dropped, ...rest } = queryOf(options)
		return serve(method, path, { query: rest })
	}
}

/** A record written by someone else while a check reads. */
export const LATECOMER: Record_ = { id: "n9", rank: 5, score: 4, status: "open", title: "Zeta late" }

/** The backend over the cohort, gaining a record once `after` listing reads have been answered. */
export function growing(after: number): Responder {
	let reads = 0
	const before = backend(NOTES)
	const later = backend([...NOTES, LATECOMER])
	return (method, path, options) => {
		reads += 1
		return (reads > after ? later : before)(method, path, options)
	}
}

/** `serve` for the first `after` listing reads, then a refusal for every one after. */
export function refusingAfter(after: number, serve: Responder = backend()): Responder {
	let reads = 0
	return (method, path, options) => {
		reads += 1
		return reads > after ? REJECT : serve(method, path, options)
	}
}

/** The backend that refuses any listing whose order is `order`, and serves the rest. */
export function refusingOrder(order: string, serve: Responder = backend()): Responder {
	return (method, path, options) =>
		method === "GET" && path === PATH && queryOf(options)["order"] === order ? REJECT : serve(method, path, options)
}
