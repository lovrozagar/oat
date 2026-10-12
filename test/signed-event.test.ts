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
	return {
		info: { title: "signed", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/billing/webhooks/stripe": {
				post: {
					operationId: "billing.stripeWebhook",
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/organizations/{organization_id}/billing/credits"],
					"x-signed-event": true,
				},
			},
			"/v1/organizations/{organization_id}/billing/credits": {
				get: {
					operationId: "billing.creditBalance",
					parameters: [{ in: "path", name: "organization_id", required: true, schema: { type: "string" } }],
					responses: { "200": { description: "ok" } },
				},
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

describe("signed events", () => {
	it("passes when the follow-up read gains a value from the signed body", async () => {
		const body = JSON.stringify({
			data: { object: { id: "cs_oat_signed_event_1" } },
			id: "evt_oat_signed_event_1",
			type: "checkout.session.completed",
		})
		let posted = ""
		const base = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document()))
				return
			}
			if (req.method === "POST") {
				const chunks: Buffer[] = []
				req.on("data", (chunk: Buffer) => chunks.push(chunk))
				req.on("end", () => {
					posted = Buffer.concat(chunks).toString("utf8")
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ received: true }))
				})
				return
			}
			const payload = posted.includes("cs_oat_signed_event_1")
				? { available: 1000, packs: [{ stripe_checkout_session_id: "cs_oat_signed_event_1" }] }
				: { available: 0, packs: [] }
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(payload))
		})
		const result = await run({
			baseUrl: base,
			hooks: {
				resolveSignedEvent: async () => ({ body, headers: { "stripe-signature": "t=1,v1=abc" } }),
			},
			ops: ["billing.stripeWebhook"],
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha", roots: { organization_id: "org_1" } }],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		expect(posted).toBe(body)
		expect(result.scope.operations.find((op) => op.operationId === "billing.stripeWebhook")?.status).toBe("passed")
	})

	it("fails when the follow-up read ignores the signed body", async () => {
		const body = JSON.stringify({
			data: { object: { id: "cs_oat_signed_event_2" } },
			id: "evt_oat_signed_event_2",
		})
		const base = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document()))
				return
			}
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(req.method === "POST" ? { received: true } : { available: 0, packs: [] }))
		})
		const result = await run({
			baseUrl: base,
			hooks: {
				resolveSignedEvent: async () => ({ body, headers: { "stripe-signature": "t=1,v1=abc" } }),
			},
			ops: ["billing.stripeWebhook"],
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha", roots: { organization_id: "org_1" } }],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "billing.stripeWebhook")?.status).toBe("failed")
	})
})
