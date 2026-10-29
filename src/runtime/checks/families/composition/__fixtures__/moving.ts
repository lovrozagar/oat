import type { Record_ } from "../../../../world/records.ts"
import type { Responder } from "../../../__fixtures__/harness.ts"
import { answer, NOTES, PARAMS, PATH, queryOf } from "./query-api.ts"

/*
 * The notes listing as a correct backend that another writer shares. Entities in other lanes run
 * beside a check, and one of them may create, change or delete a record in the very collection the
 * check reads term by term: a full prod run read three searches, then another entity created a
 * template matching the last two, and the intersection came out one short of the combined read.
 */

/** A record another check made for itself, outside the cohort, matching every search and filter. */
export const SCRATCH: Record_ = { author: null, id: "s1", rank: 7, score: 2, status: "open", title: "Alpha Beta memo" }

/** What the other writer does to the collection. */
export type Move = "update" | "create" | "delete"

export const MOVES: readonly Move[] = ["update", "create", "delete"]

function apply(store: Record_[], move: Move): void {
	const at = store.findIndex((row) => row["id"] === "s1")
	if (move === "update") Object.assign(store[at] ?? {}, { rank: 70, status: "archived", title: "Omega" })
	if (move === "create") store.push({ ...SCRATCH, id: "s2", rank: 8, title: "Alpha Beta report" })
	if (move === "delete") store.splice(at, 1)
}

/* A term is one query walked across its pages: the query without its page. */
function termOf(query: Readonly<Record<string, string>>): string {
	const { page: _page, ...rest } = query
	return JSON.stringify(rest)
}

/**
 * A correct backend over the cohort and `SCRATCH`, where the other writer moves once term `after`
 * was read: just before the first page of the next term, however many pages each term took.
 */
export function moving(after: number, move: Move): Responder {
	const store = [...NOTES, SCRATCH].map((row) => ({ ...row }))
	const accepted = [...PARAMS, "page"]
	let terms = 0
	let last: string | undefined
	return (method, path, request) => {
		if (method !== "GET" || path !== PATH) return undefined
		const query = queryOf(request)
		const term = termOf(query)
		if (term !== last && ++terms === after + 1) apply(store, move)
		last = term
		return answer(store, query, accepted)
	}
}
