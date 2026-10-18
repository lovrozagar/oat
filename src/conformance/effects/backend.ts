/** The effects suite's backend: tables in a project, and an extract that makes a table of `rowCount` rows. */

import type { Handle } from "../../reference/http/node.ts"
import { routed } from "../harness/routes.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"
import { extractSpec } from "./spec.ts"

interface Table {
	id: string
	name: string
	table_id: string
}

type Row = Pick<Table, "id" | "table_id">

export function extractBackend(rowCount: number): Handle {
	const spec = extractSpec()
	/* A table and its rows are made together, so a table never lacks its row list. */
	const tables = new Map<string, { table: Table; rows: Row[] }>()
	let seq = 0
	const make = (name: string, rows: (id: string) => Row[]): Table => {
		const id = `t_${String((seq += 1))}`
		const table = { id, name, table_id: id }
		tables.set(id, { rows: rows(id), table })
		return table
	}
	const list = /^\/v1\/projects\/([^/]+)\/tables$/
	return guarded(
		routed([
			{ method: "GET", path: /^\/v1\/openapi\/spec$/, reply: () => answer(200, spec) },
			{ method: "GET", path: list, reply: () => answer(200, { tables: [...tables.values()].map((t) => t.table) }) },
			{
				method: "POST",
				path: list,
				reply: async (_, request) => {
					const body = (await readJson(request)) as { name?: unknown } | undefined
					return answer(
						201,
						make(typeof body?.name === "string" ? body.name : "n", () => []),
					)
				},
			},
			{
				method: "GET",
				path: /^\/v1\/projects\/[^/]+\/tables\/([^/]+)$/,
				reply: (id) => {
					const found = tables.get(decodeURIComponent(id))
					return found === undefined ? answer(404) : answer(200, found.table)
				},
			},
			{
				method: "GET",
				path: /^\/v1\/projects\/[^/]+\/tables\/([^/]+)\/rows$/,
				reply: (id) => {
					const found = tables.get(decodeURIComponent(id))
					return found === undefined ? answer(404) : answer(200, { rows: found.rows })
				},
			},
			{
				method: "POST",
				path: /^\/v1\/projects\/([^/]+)\/extract$/,
				reply: () =>
					answer(
						200,
						make("extracted", (id) =>
							Array.from({ length: rowCount }, (_, i) => ({ id: `r_${id}_${String(i + 1)}`, table_id: id })),
						),
					),
			},
		]),
	)
}
