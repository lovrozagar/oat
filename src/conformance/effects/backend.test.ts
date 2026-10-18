import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { extractBackend } from "./backend.ts"

const TABLES = "/v1/projects/p1/tables"

function caller(rowCount: number) {
	const handle = extractBackend(rowCount)
	return async (method: string, path: string, body = "") => {
		const answer = await handle(referenceRequest(method, new URL(path, "http://suite.test"), {}, async () => body))
		return [answer.status, answer.body]
	}
}

describe("extractBackend", () => {
	it("creates tables, named or not, each with an empty row list", async () => {
		const call = caller(0)
		expect(await call("POST", TABLES, '{"name":"a"}')).toEqual([201, '{"id":"t_1","name":"a","table_id":"t_1"}'])
		expect(await call("POST", TABLES)).toEqual([201, '{"id":"t_2","name":"n","table_id":"t_2"}'])
		expect(await call("GET", `${TABLES}/t_2`)).toEqual([200, '{"id":"t_2","name":"n","table_id":"t_2"}'])
		expect(await call("GET", `${TABLES}/t_2/rows`)).toEqual([200, '{"rows":[]}'])
		expect(JSON.parse(String((await call("GET", TABLES))[1])).tables).toHaveLength(2)
	})

	it("extracts a table of its row count", async () => {
		const call = caller(2)
		expect(await call("POST", "/v1/projects/p1/extract")).toEqual([
			200,
			'{"id":"t_1","name":"extracted","table_id":"t_1"}',
		])
		expect(await call("GET", `${TABLES}/t_1/rows`)).toEqual([
			200,
			'{"rows":[{"id":"r_t_1_1","table_id":"t_1"},{"id":"r_t_1_2","table_id":"t_1"}]}',
		])
	})

	it("answers a missing table, its rows, an unknown route and a malformed body", async () => {
		const call = caller(0)
		expect(await call("GET", `${TABLES}/t_9`)).toEqual([404, ""])
		expect(await call("GET", `${TABLES}/t_9/rows`)).toEqual([404, ""])
		expect(await call("DELETE", TABLES)).toEqual([404, ""])
		expect(await call("POST", TABLES, "{")).toEqual([500, ""])
	})
})
