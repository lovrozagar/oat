import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createMemoryServer, createSqliteServer, type ReferenceServer } from "../src/reference/http.ts"

/* The reference backend's null rules (`src/reference/query.ts`) are decided once and every store
 * must hold them. `eq.null` compares against the text "null", as PostgREST does; `is.null` is the
 * test for a missing value. */

const AUTH = { authorization: "Bearer tok_alpha", "content-type": "application/json" }
const JOBS = "/v1/projects/proj_alpha/jobs"

async function seed(server: ReferenceServer): Promise<void> {
	for (const [name, note] of [
		["none", null],
		["word", "null"],
		["abc", "abc"],
	] as const) {
		const response = await fetch(`${server.url}${JOBS}`, {
			body: JSON.stringify({ name, note }),
			headers: AUTH,
			method: "POST",
		})
		expect(response.status).toBeLessThan(300)
	}
}

async function names(server: ReferenceServer, filter: string): Promise<string[]> {
	const url = `${server.url}${JOBS}?limit=100&filter=${encodeURIComponent(filter)}`
	const body = (await (await fetch(url, { headers: AUTH })).json()) as Record<string, unknown>
	const rows = Object.values(body).find(Array.isArray) as Array<{ name: string }>
	return rows.map((row) => row.name).sort()
}

const CASES: Array<[filter: string, expected: string[]]> = [
	["note.eq.null", ["word"]],
	["note.neq.abc", ["none", "word"]],
	["note.in.(abc,null)", ["abc", "word"]],
	["note.nin.(abc)", ["none", "word"]],
	["note.lt.b", ["abc"]],
	["note.lte.abc", ["abc"]],
	["note.is.null", ["none"]],
	["note.is.notnull", ["abc", "word"]],
]

describe("null semantics", () => {
	const servers: Array<[string, ReferenceServer]> = []
	beforeAll(async () => {
		for (const [label, create] of [
			["memory", createMemoryServer],
			["sqlite", createSqliteServer],
		] as const) {
			const server = await create()
			await seed(server)
			servers.push([label, server])
		}
	})
	afterAll(async () => {
		for (const [, server] of servers) await server.close()
	})

	for (const [filter, expected] of CASES) {
		it(`${filter} selects the same rows in every store`, async () => {
			for (const [label, server] of servers) {
				expect({ [label]: await names(server, filter) }).toEqual({ [label]: expected })
			}
		})
	}
})
