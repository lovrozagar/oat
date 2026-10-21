import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { EXTRACT_TOKEN, extractBackend } from "./backend.ts"

const TABLES = "/v1/projects/p1/tables"

/* A caller of a fresh backend, sending the token it issues unless `headers` says otherwise. */
function caller(rowCount: number, headers: Record<string, string> = { authorization: `Bearer ${EXTRACT_TOKEN}` }) {
	const handle = extractBackend(rowCount)
	return async (method: string, path: string, body = "") => {
		const answer = await handle(
			referenceRequest(method, new URL(path, "http://suite.test"), { headers, read: async () => body }),
		)
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

	it("refuses a request without the token it issued, and serves its document to anyone", async () => {
		expect(await caller(0, {})("GET", TABLES)).toEqual([401, '{"error_key":"unauthorized"}'])
		expect((await caller(0, { authorization: "Bearer forged" })("POST", "/v1/projects/p1/extract"))[0]).toBe(401)
		expect((await caller(0, {})("GET", "/v1/openapi/spec"))[0]).toBe(200)
	})

	it("answers a missing table, its rows, an unknown route and a malformed body", async () => {
		const call = caller(0)
		expect(await call("GET", `${TABLES}/t_9`)).toEqual([404, ""])
		expect(await call("GET", `${TABLES}/t_9/rows`)).toEqual([404, ""])
		expect(await call("DELETE", TABLES)).toEqual([404, ""])
		expect(await call("POST", TABLES, "{")).toEqual([500, ""])
	})
})
