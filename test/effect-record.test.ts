import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { run } from "../src/runtime/run.ts"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function document(): OpenApiDocument {
	const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
	const get = (operationId: string, parameters: unknown[]) => ({
		operationId,
		parameters,
		responses: { "200": { description: "ok" } },
		"x-effect-record": true,
		"x-entity": { action: "action", name: "newsletter" },
	})
	return {
		info: { title: "effect", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/nl/c/{delivery_id}/{encoded_url}": {
				get: get("newsletter.clickRedirect", [param("delivery_id"), param("encoded_url")]),
			},
			"/nl/o/{delivery_id}": {
				get: get("newsletter.openPixel", [param("delivery_id")]),
			},
		},
	} as OpenApiDocument
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo
			open.push({ close: () => new Promise((done) => server.close(() => done())) })
			resolve(`http://127.0.0.1:${address.port}`)
		})
	})
}

it("passes when this run's record contains the mailed path", async () => {
	const records: Array<{ at: number; event: string; path: string }> = []
	const base = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document()))
			return
		}
		records.push({ at: Date.now(), event: url.pathname.includes("/nl/o/") ? "open" : "click", path: url.pathname })
		res.writeHead(200, { "content-type": "image/gif" })
		res.end("gif")
	})
	const result = await run({
		baseUrl: base,
		hooks: {
			resolveOutOfBand: async (req) => {
				if (req.kind.includes("open")) return "https://anyrow.ai/app/nl/o/ndel_1"
				if (req.kind.includes("click")) return "https://anyrow.ai/app/nl/c/ndel_1/aGVsbG8"
				return null
			},
			resolveRunRecord: async () => records,
		},
		nonce: "n1",
		ops: ["newsletter.openPixel", "newsletter.clickRedirect"],
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${base}/openapi.json`,
	})
	expect(result.scope.operations.find((op) => op.operationId === "newsletter.openPixel")?.status).toBe("passed")
	expect(result.scope.operations.find((op) => op.operationId === "newsletter.clickRedirect")?.status).toBe("passed")
	expect(records.map((item) => item.path).sort()).toEqual(["/nl/c/ndel_1/aGVsbG8", "/nl/o/ndel_1"])
})

it("fails when the record path is not the path this call sent", async () => {
	const base = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document()))
			return
		}
		res.writeHead(200, { "content-type": "image/gif" })
		res.end("gif")
	})
	const result = await run({
		baseUrl: base,
		hooks: {
			resolveOutOfBand: async () => "https://anyrow.ai/app/nl/o/ndel_1",
			resolveRunRecord: async () => [{ at: Date.now(), event: "open", path: "/nl/o/other" }],
		},
		nonce: "n1",
		ops: ["newsletter.openPixel"],
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${base}/openapi.json`,
	})
	expect(result.scope.operations.find((op) => op.operationId === "newsletter.openPixel")?.status).toBe("failed")
})
