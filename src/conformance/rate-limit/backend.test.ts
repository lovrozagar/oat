import { describe, expect, it } from "vitest"
import type { Handle } from "../../reference/http/node.ts"
import { referenceRequest } from "../../reference/http/wire.ts"
import { planLimitedTables, untaggedThings } from "./backend.ts"

/* Sends `handle` one request and reads back its status and body. */
function caller(handle: Handle) {
	return async (method: string, path: string, body = "") => {
		const answer = await handle(
			referenceRequest(method, new URL(path, "http://suite.test"), { headers: {}, read: async () => body }),
		)
		return [answer.status, answer.body]
	}
}

describe("untaggedThings", () => {
	it("refuses the first create with a 429 that says to retry now, then creates", async () => {
		const handle = untaggedThings()
		const call = caller(handle)
		const first = await handle(
			referenceRequest("POST", new URL("http://suite.test/v1/things"), { headers: {}, read: async () => "" }),
		)
		expect([first.status, first.headers["retry-after"]]).toEqual([429, "0"])
		expect(await call("POST", "/v1/things")).toEqual([201, '{"id":"t_2","name":"n"}'])
		expect(await call("GET", "/v1/things/t_2")).toEqual([200, '{"id":"t_2","name":"n"}'])
		expect(await call("DELETE", "/v1/things/t_2")).toEqual([204, ""])
		expect(await call("GET", "/v1/things/t_2")).toEqual([404, ""])
		expect(await call("PUT", "/v1/things")).toEqual([404, ""])
	})
})

describe("planLimitedTables", () => {
	it("refuses a table create as a plan limit, and serves the table that exists", async () => {
		const call = caller(planLimitedTables())
		expect(await call("POST", "/v1/tables")).toEqual([
			402,
			'{"error_key":"table_plan_limit","status_key":"payment_required"}',
		])
		expect(await call("GET", "/v1/tables/tbl_extract")).toEqual([200, '{"id":"tbl_extract","name":"from-extract"}'])
		expect(await call("GET", "/v1/tables/tbl_other")).toEqual([404, ""])
		expect(await call("DELETE", "/v1/tables/tbl_extract")).toEqual([204, ""])
	})

	it("creates rows only in a table that exists, named or not", async () => {
		const call = caller(planLimitedTables())
		expect(await call("POST", "/v1/tables/tbl_other/rows", "{}")).toEqual([404, ""])
		expect(await call("POST", "/v1/tables/tbl_extract/rows", '{"name":"a"}')).toEqual([
			201,
			'{"id":"r_1","name":"a","table_id":"tbl_extract"}',
		])
		expect(await call("POST", "/v1/tables/tbl_extract/rows")).toEqual([
			201,
			'{"id":"r_2","name":"n","table_id":"tbl_extract"}',
		])
		expect(await call("GET", "/v1/tables/tbl_extract/rows/r_3")).toEqual([404, ""])
		expect(await call("DELETE", "/v1/tables/tbl_extract/rows/r_1")).toEqual([204, ""])
	})

	it("answers a malformed body with a bare 500", async () => {
		expect(await caller(planLimitedTables())("POST", "/v1/tables/tbl_extract/rows", "{")).toEqual([500, ""])
	})
})
