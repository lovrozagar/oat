/** The rate-limit suite's two backends, each a fresh `Handle` with its own rows. */

import type { Handle } from "../../reference/http/node.ts"
import { type Route, routed } from "../harness/routes.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"
import { planLimitSpec, thingSpec } from "./spec.ts"

interface Named {
	id: string
	name: string
}

const SPEC = /^\/v1\/openapi\/spec$/

/** A read of `id` from `rows`: the row, or a bare 404. */
function readRow<T>(rows: ReadonlyMap<string, T>, id: string) {
	const row = rows.get(id)
	return row === undefined ? answer(404) : answer(200, row)
}

/** Untagged things whose first create is a 429 with `Retry-After: 0`; every later create succeeds. */
export function untaggedThings(): Handle {
	const document = thingSpec()
	const rows = new Map<string, Named>()
	let posts = 0
	const item = /^\/v1\/things\/([^/]+)$/
	return guarded(
		routed([
			{ method: "GET", path: SPEC, reply: () => answer(200, document) },
			{ method: "GET", path: /^\/v1\/things$/, reply: () => answer(200, { items: [...rows.values()] }) },
			{
				method: "POST",
				path: /^\/v1\/things$/,
				reply: () => {
					posts += 1
					if (posts === 1) return answer(429, { error: "too_many_requests" }, { "retry-after": "0" })
					const row = { id: `t_${String(posts)}`, name: "n" }
					rows.set(row.id, row)
					return answer(201, row)
				},
			},
			{ method: "DELETE", path: item, reply: (id) => (rows.delete(id), answer(204)) },
			{ method: "GET", path: item, reply: (id) => readRow(rows, id) },
		]),
	)
}

/** The row routes of the plan-limited backend: rows live only in a table that exists. */
function rowRoutes(tables: ReadonlyMap<string, Named>): Route[] {
	const rows = new Map<string, Named & { table_id: string }>()
	let sequence = 0
	const collection = /^\/v1\/tables\/([^/]+)\/rows$/
	const item = /^\/v1\/tables\/[^/]+\/rows\/([^/]+)$/
	return [
		{ method: "GET", path: collection, reply: () => answer(200, { items: [...rows.values()] }) },
		{
			method: "POST",
			path: collection,
			reply: async (table, request) => {
				const tableId = decodeURIComponent(table)
				if (!tables.has(tableId)) return answer(404)
				const body = ((await readJson(request)) ?? {}) as { name?: string }
				sequence += 1
				const row = { id: `r_${String(sequence)}`, name: body.name ?? "n", table_id: tableId }
				rows.set(row.id, row)
				return answer(201, row)
			},
		},
		{ method: "GET", path: item, reply: (id) => readRow(rows, decodeURIComponent(id)) },
		{ method: "DELETE", path: item, reply: () => answer(204) },
	]
}

/** One table that already exists, a table create refused as a plan limit (402), and rows. */
export function planLimitedTables(): Handle {
	const document = planLimitSpec()
	const tables = new Map<string, Named>([["tbl_extract", { id: "tbl_extract", name: "from-extract" }]])
	const item = /^\/v1\/tables\/([^/]+)$/
	return guarded(
		routed([
			{ method: "GET", path: SPEC, reply: () => answer(200, document) },
			{ method: "GET", path: /^\/v1\/tables$/, reply: () => answer(200, { items: [...tables.values()] }) },
			{
				method: "POST",
				path: /^\/v1\/tables$/,
				reply: () => answer(402, { error_key: "table_plan_limit", status_key: "payment_required" }),
			},
			{ method: "GET", path: item, reply: (id) => readRow(tables, decodeURIComponent(id)) },
			{ method: "DELETE", path: item, reply: () => answer(204) },
			...rowRoutes(tables),
		]),
	)
}
