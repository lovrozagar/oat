import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createFresh } from "../../src/runtime/checks/payloads/create.ts"
import { Client } from "../../src/runtime/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { buildModel } from "../../src/spec/graph.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"

/*
 * A client-chosen identity oat has never seen can still be taken: another tenant's record holds
 * it, and the server's id space spans tenants. The create answers 409, and a check that needed a
 * record of its own went inconclusive (conformance, shape:client-ids, about one run in sixteen).
 * Another identity is the cure; for a body with no client-chosen identity, a 409 means something
 * else and is the answer.
 */

const WITH_ID = {
	properties: { id: { maximum: 999, minimum: 1, type: "integer" }, name: { minLength: 1, type: "string" } },
	required: ["id", "name"],
	type: "object",
}
const WITHOUT_ID = { properties: { name: { minLength: 1, type: "string" } }, required: ["name"], type: "object" }

let server: Server | undefined
afterEach(() => server?.close())

/** A server that answers the first `conflicts` creates with 409, then 201 with the body. */
async function serve(conflicts: number): Promise<{ base: string; sent: Array<Record<string, unknown>> }> {
	const sent: Array<Record<string, unknown>> = []
	const listening = createServer((req, res) => {
		let text = ""
		req.on("data", (chunk) => (text += chunk))
		req.on("end", () => {
			const body = JSON.parse(text || "{}") as Record<string, unknown>
			sent.push(body)
			const conflict = sent.length <= conflicts
			res.writeHead(conflict ? 409 : 201, { "content-type": "application/json" })
			res.end(JSON.stringify(conflict ? { error: `id ${String(body.id)} is taken` } : body))
		})
	})
	server = listening
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve))
	return { base: `http://127.0.0.1:${(listening.address() as AddressInfo).port}`, sent }
}

function context(base: string, schema: Record<string, unknown>) {
	const response = { content: { "application/json": { schema } }, description: "ok" }
	const document = {
		info: { title: "create-fresh", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": { content: { "application/json": { schema: { items: schema, type: "array" } } }, description: "ok" },
					},
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema } }, required: true },
					responses: { "201": response, "409": { description: "taken" } },
				},
			},
		},
	} as OpenApiDocument
	const model = buildModel(document)
	const listOp = model.byOperationId.get("note.list")
	const createOp = model.byOperationId.get("note.create")
	if (listOp === undefined || createOp === undefined) throw new Error("operations missing")
	const ctx = checkContext({
		client: new Client(base),
		createOp,
		entityName: "note",
		findings: new FindingCollector(),
		listOp,
		model,
		takenIdentities: new Set<string>(),
	})
	return { createOp, ctx }
}

describe("createFresh", () => {
	it("sends another client-chosen identity when the first is taken", async () => {
		const { base, sent } = await serve(1)
		const { createOp, ctx } = context(base, WITH_ID)
		const created = await createFresh(ctx, createOp, WITH_ID, ctx.auth())
		expect(created.exchange.status).toBe(201)
		expect(sent).toHaveLength(2)
		expect(sent[1]?.id).not.toBe(sent[0]?.id)
		expect(created.sent.id).toBe(sent[1]?.id)
	})

	it("gives up after three identities, answering the last 409", async () => {
		const { base, sent } = await serve(10)
		const { createOp, ctx } = context(base, WITH_ID)
		const created = await createFresh(ctx, createOp, WITH_ID, ctx.auth())
		expect(created.exchange.status).toBe(409)
		expect(new Set(sent.map((body) => body.id)).size).toBe(3)
	})

	it("answers a 409 as it is when the body names no identity of its own", async () => {
		const { base, sent } = await serve(1)
		const { createOp, ctx } = context(base, WITHOUT_ID)
		const created = await createFresh(ctx, createOp, WITHOUT_ID, ctx.auth())
		expect(created.exchange.status).toBe(409)
		expect(sent).toHaveLength(1)
	})
})
