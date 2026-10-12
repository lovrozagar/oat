import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { run } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const item = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function spec(): OpenApiDocument {
	const entity = { name: "catalogue" }
	return {
		info: { title: "catalogue", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/templates": {
				get: {
					operationId: "catalogue.list",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: { "application/json": { schema: { items: item, type: "array" } } },
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { ...entity, action: "list" },
					"x-tenant": false,
				},
				post: {
					operationId: "catalogue.create",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: item } }, description: "created" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { ...entity, action: "create" },
					"x-tenant": false,
				},
			},
			"/v1/projects/{project_id}/templates/{id}": {
				get: {
					operationId: "catalogue.get",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": { content: { "application/json": { schema: item } }, description: "ok" },
						"401": { description: "unauthorized" },
						"404": { description: "missing" },
					},
					"x-entity": { ...entity, action: "read", identity: "id" },
					"x-tenant": false,
				},
			},
		},
	} as OpenApiDocument
}

async function serve(): Promise<string> {
	const document = spec()
	const rows: Array<{ id: string; name: string }> = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document))
				return
			}
			const token = typeof req.headers.authorization === "string" ? req.headers.authorization : ""
			if (token !== "Bearer alpha" && token !== "Bearer beta") {
				res.writeHead(401, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: "unauthorized" }))
				return
			}
			const parts = url.pathname.split("/").filter(Boolean)
			if (
				parts[0] === "v1" &&
				parts[1] === "projects" &&
				parts[3] === "templates" &&
				parts.length === 4 &&
				method === "GET"
			) {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(rows))
				return
			}
			if (parts.length === 4 && method === "POST") {
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: unknown }
				if (typeof body.name !== "string" || body.name === "") {
					res.writeHead(400, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "invalid" }))
					return
				}
				const row = { id: `tpl_${rows.length + 1}`, name: body.name }
				rows.push(row)
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify(row))
				return
			}
			if (parts.length === 5 && method === "GET") {
				const row = rows.find((item) => item.id === parts[4])
				if (row === undefined) {
					res.writeHead(404, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "missing" }))
					return
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(row))
				return
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

describe("shared catalogue", () => {
	it("does not call a shared template a tenant leak", async () => {
		const url = await serve()
		const result = await run({
			baseUrl: url,
			principals: [
				{ headers: { authorization: "Bearer alpha" }, id: "alpha", roots: { project_id: "proj_alpha" } },
				{ headers: { authorization: "Bearer beta" }, id: "beta", roots: { project_id: "proj_beta" } },
			],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		/* The only get in this run asked for an id that was never listed (404): no pass to claim. */
		const get = result.scope.operations.find((op) => op.operationId === "catalogue.get")
		expect(get?.status).not.toBe("failed")
		expect(get?.findings).toBe(0)
	})
})
