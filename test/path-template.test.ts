import { describe, expect, it } from "vitest"
import { pathTemplateParams } from "../src/spec/load.ts"
import { operationResolver } from "../src/spec/graph.ts"
import { Client } from "../src/runtime/client.ts"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { SpecModel } from "../src/spec/graph.ts"

/*
 * The values a request put in its path, read back against the template it resolved to. A create's
 * own path names the scope its record lives in, whichever principal sent it and under whatever root.
 */

describe("pathTemplateParams", () => {
	it("reads each parameter's value out of a matching path, URI-decoded", () => {
		expect(
			pathTemplateParams("/v1/projects/{project_id}/tables/{table_id}", "/v1/projects/p%201/tables/t%2F2"),
		).toEqual({ project_id: "p 1", table_id: "t/2" })
	})

	it("accepts the `:param` syntax as `{param}`", () => {
		expect(pathTemplateParams("/things/:thing_id", "/things/abc")).toEqual({ thing_id: "abc" })
	})

	it("is null for a path the template does not match", () => {
		expect(pathTemplateParams("/v1/tables/{table_id}", "/v1/tables")).toBeNull()
		expect(pathTemplateParams("/v1/tables/{table_id}", "/v1/tables/1/rows")).toBeNull()
		expect(pathTemplateParams("/v1/tables.json", "/v1/tablesxjson")).toBeNull()
	})

	it("is empty for a template without parameters", () => {
		expect(pathTemplateParams("/v1/tables", "/v1/tables")).toEqual({})
	})

	it("keeps a value that is not valid URI encoding as it was sent", () => {
		expect(pathTemplateParams("/t/{id}", "/t/100%")).toEqual({ id: "100%" })
	})
})

describe("an exchange's path parameters", () => {
	const model = {
		operations: [
			{ entity: "table", method: "GET", operationId: "table.list", path: "/projects/{project_id}/tables" },
			{
				entity: "table",
				method: "GET",
				operationId: "table.read",
				path: "/projects/{project_id}/tables/{table_id}",
			},
		].map((op) => ({ ...op, requiredQuery: {}, statuses: { default: false, exact: [200], ranges: [] } })),
	} as unknown as SpecModel

	it("come from the operation the request resolved to", () => {
		expect(operationResolver(model)("GET", "/projects/a/tables/t1")?.pathParams).toEqual({
			project_id: "a",
			table_id: "t1",
		})
	})

	it("are stamped on the exchange the client records", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end("{}")
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
			client.setOperationResolver(operationResolver(model))
			const exchange = await client.get("/projects/b/tables/t%209")
			expect(exchange.pathParams).toEqual({ project_id: "b", table_id: "t 9" })
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
