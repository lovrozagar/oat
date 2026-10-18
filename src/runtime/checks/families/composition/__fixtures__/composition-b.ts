import type { Record_ } from "../../../../world.ts"
import { type Answer, modelOf, op, type Responder } from "../../../__fixtures__/harness.ts"
import type { CheckContext } from "../../../core/context.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { backend, LIST, NOTES, PARAMS, queryDoc, queryOf } from "./query-api.ts"

/*
 * Defects for the composition checks, planted by rewriting each request's query before the
 * correct backend answers it: a parameter dropped when another is present, a page that never
 * ends, a refusal for one shape of request.
 */

type Query = Record<string, string>

/** The notes document with page numbers, so a read can be walked — and left unfinished. */
export function pagedDoc(): OpenApiDocument {
	return queryDoc({}, [...PARAMS, "page"])
}

/** A rewrite of one request: the query the correct backend answers instead, or an answer outright. */
export type Rewrite = (query: Query) => Query | Answer

const isAnswer = (value: Query | Answer): value is Answer => typeof value.status === "number"

/** The correct backend over `rows`, answering each request as `rewrite` changes it. */
export function rewriting(rewrite: Rewrite, rows: readonly Record_[] = NOTES): Responder {
	const correct = backend(rows)
	return (method, path, options) => {
		const out = rewrite(queryOf(options))
		return isAnswer(out) ? out : correct(method, path, { query: out })
	}
}

/** `query` without `keys`. */
export function without(query: Query, ...keys: string[]): Query {
	return Object.fromEntries(Object.entries(query).filter(([key]) => !keys.includes(key)))
}

/** Whether `query` carries every one of `keys`. */
export const carries = (query: Query, ...keys: string[]): boolean => keys.every((key) => key in query)

/** `drop` is ignored whenever every one of `present` is in the request too. */
export function dropWhen(drop: string, ...present: string[]): Responder {
	return rewriting((query) => (carries(query, ...present) ? without(query, drop) : query))
}

/** Requests carrying every one of `keys` ignore the page number, so their walk never ends. */
export function endlessWhen(...keys: string[]): Responder {
	return rewriting((query) => (carries(query, ...keys) ? without(query, "page") : query))
}

/**
 * A listing whose select parameter is there when the plan's gate asks and gone when the term is
 * written: the one way to reach a plan's "the grammar cannot express this projection" branch,
 * which a document alone never does — a declared select parameter always renders.
 */
export function fleetingSelect(): Partial<CheckContext> {
	const listOp = op(modelOf(queryDoc()), LIST)
	let reads = 0
	const conventions = Object.create(listOp.conventions, {
		select: { get: () => (reads++ === 0 ? "select" : undefined) },
	}) as typeof listOp.conventions
	return { listOp: { ...listOp, conventions } }
}
