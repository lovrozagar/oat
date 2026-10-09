import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"
import { isBodyRef } from "../src/runtime/transcript.ts"

let url = ""
let close = async (): Promise<void> => {}
let unauthorizedOnce = true

beforeAll(async () => {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const path = new URL(req.url ?? "/", "http://x").pathname
		if (path === "/api/v1/big") {
			const body = JSON.stringify({ items: "x".repeat(300 * 1024) })
			res.writeHead(200, { "content-type": "application/json" })
			res.end(body)
			return
		}
		if (path === "/api/v1/guarded" && unauthorizedOnce) {
			unauthorizedOnce = false
			res.writeHead(401, { "content-type": "application/json" })
			res.end("{}")
			return
		}
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ path }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

describe("exchange model", () => {
	it("resolves operations below the base path and stamps who asked and why", async () => {
		const client = new Client(url)
		client.setOperationResolver((method, path) =>
			method === "GET" && /^\/v1\/tables\/[^/]+$/.test(path)
				? { operationId: "table.get", template: "/v1/tables/{table_id}" }
				: null,
		)
		client.setPrincipalResolver((headers) => (headers.authorization === "Bearer a" ? "alpha" : undefined))
		expect(client.relativePath(`${url}/v1/tables/1`)).toBe("/v1/tables/1")
		/* A sibling path that merely starts with the same letters is not below the base. */
		const sibling = new URL(url)
		sibling.pathname = `${sibling.pathname.replace(/\/$/, "")}v2/v1/tables/1`
		expect(client.relativePath(sibling.toString())).toBe(sibling.pathname)

		const view = client.view({ check: "c.one", subject: "table" })
		const exchange = await view.get("/v1/tables/7", {
			context: { purpose: "probe" },
			headers: { authorization: "Bearer a" },
		})
		expect(exchange).toMatchObject({
			check: "c.one",
			operationId: "table.get",
			principal: "alpha",
			purpose: "probe",
			subject: "table",
			template: "/v1/tables/{table_id}",
		})
		expect(client.exchangesFor("table.get")).toHaveLength(1)
		expect(client.exchangesFor("nothing")).toEqual([])
		const nested = view.view({ purpose: "assertion" })
		expect((await nested.request("GET", "/v1/other")).check).toBe("c.one")
	})

	it("hands the caller the real body and keeps a compact copy", async () => {
		const client = new Client(url)
		const exchange = await client.get("/v1/big")
		expect(typeof (exchange.responseBody as { items: string }).items).toBe("string")
		expect(isBodyRef(client.transcript.at(-1)?.responseBody)).toBe(true)
	})

	it("marks an answer asked again after a refresh as superseded", async () => {
		const client = new Client(url)
		let refreshed = 0
		const exchange = await client.get("/v1/guarded", {
			refreshIfStale: async (force) => {
				if (force === true) refreshed++
			},
		})
		expect(refreshed).toBe(1)
		expect(exchange.status).toBe(200)
		expect(client.transcript.map((item) => [item.status, item.superseded === true])).toEqual([
			[401, true],
			[200, false],
		])
	})
})
