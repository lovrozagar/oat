import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"

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

type Template = { id: string; name: string }

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

async function createTemplate(rows: Template[], req: IncomingMessage, res: ServerResponse): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: unknown }
	if (typeof body.name !== "string" || body.name === "") return sendJson(res, 400, { error: "invalid" })
	const row = { id: `tpl_${rows.length + 1}`, name: body.name }
	rows.push(row)
	sendJson(res, 201, row)
}

function readTemplate(rows: Template[], id: string | undefined, res: ServerResponse): void {
	const row = rows.find((template) => template.id === id)
	if (row === undefined) return sendJson(res, 404, { error: "missing" })
	sendJson(res, 200, row)
}

function isTemplateList(parts: string[]): boolean {
	return parts[0] === "v1" && parts[1] === "projects" && parts[3] === "templates" && parts.length === 4
}

/* Every token sees the same templates: the catalogue is shared, not a tenant's. */
async function route(
	{ document, rows }: { document: OpenApiDocument; rows: Template[] },
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const method = (req.method ?? "GET").toUpperCase()
	if (url.pathname === "/openapi.json") return sendJson(res, 200, document)
	const token = typeof req.headers.authorization === "string" ? req.headers.authorization : ""
	if (token !== "Bearer alpha" && token !== "Bearer beta") return sendJson(res, 401, { error: "unauthorized" })
	const parts = url.pathname.split("/").filter(Boolean)
	if (isTemplateList(parts) && method === "GET") return sendJson(res, 200, rows)
	if (parts.length === 4 && method === "POST") return createTemplate(rows, req, res)
	if (parts.length === 5 && method === "GET") return readTemplate(rows, parts[4], res)
	res.writeHead(404)
	res.end()
}

async function serve(): Promise<string> {
	const document = spec()
	const rows: Template[] = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void route({ document, rows }, req, res)
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
