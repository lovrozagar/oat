import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { buildModel } from "../../src/spec/graph.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A backend that ignores the client's id and issues its own from a counter can, by chance, issue
 * the very number the client chose. One create cannot tell that apart from a kept id, so the check
 * judges several creates with distinct ids: it takes every one of them coinciding to hide the loss.
 */

const NOTE = {
	properties: { id: { maximum: 999, minimum: 1, type: "integer" }, title: { type: "string" } },
	required: ["id", "title"],
	type: "object",
}

const DOC = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			post: {
				operationId: "note.create",
				requestBody: { content: { "application/json": { schema: NOTE } }, required: true },
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { success: { type: "boolean" } }, type: "object" },
							},
						},
						description: "acknowledged",
					},
				},
			},
		},
		"/notes/{id}": {
			get: {
				operationId: "note.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
				responses: { "200": { content: { "application/json": { schema: NOTE } }, description: "ok" } },
			},
		},
	},
} as unknown as OpenApiDocument

/* Issues ids 7, 8, … whatever the client sent: the first create's chosen 7 happens to be issued. */
let url = ""
let close: () => Promise<void> = async () => {}
beforeAll(async () => {
	let next = 7
	const stored = new Map<string, unknown>()
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			if (req.method === "POST") {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
				const id = next++
				stored.set(String(id), { ...body, id })
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ success: true }))
				return
			}
			const id = (req.url ?? "").split("/").pop() ?? ""
			const record = stored.get(id)
			res.writeHead(record === undefined ? 404 : 200, { "content-type": "application/json" })
			res.end(JSON.stringify(record ?? { error: "not found" }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

describe("create.keeps-submitted-identity", () => {
	it("is not fooled when the first id the client chose is the one the server issues", async () => {
		const model = buildModel(DOC)
		const createOp = model.byOperationId.get("note.create")
		const readOp = model.byOperationId.get("note.get")
		if (createOp === undefined || readOp === undefined) throw new Error("fixture incomplete")
		const client = new Client({ baseUrl: url, redactor: new Redactor() })
		/* The seed's creates, as a run would have sent them before the check. */
		await client.request("POST", "/notes", { body: { id: 7, title: "first" }, operationId: "note.create" })
		await client.request("POST", "/notes", { body: { id: 412, title: "second" }, operationId: "note.create" })
		const findings = new FindingCollector()
		const ctx = checkContext({
			client,
			createOp,
			entityName: "note",
			findings,
			listOp: readOp,
			model,
			readOp,
		})
		const check = CHECKS.find((candidate) => candidate.id === "create.keeps-submitted-identity")
		if (check === undefined) throw new Error("no check")
		const planned = check.plan(ctx)
		expect(planned.ok).toBe(true)
		if (planned.ok) await check.run(ctx, planned.value)
		expect(findings.findings.map((finding) => `${finding.verdict} ${finding.check}`)).toEqual([
			"BACKEND_BUG create.keeps-submitted-identity",
		])
	})
})
