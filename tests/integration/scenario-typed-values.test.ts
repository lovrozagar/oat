import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* A number a response returned goes back as a number: a body field that is exactly `{name}`
 * sends the saved value with its type, as it already does for objects. */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

const spec: OpenApiDocument = {
	info: { title: "typed", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/slot": { get: { operationId: "slot.get", responses: ok } },
		"/v1/slot/decline": {
			post: {
				operationId: "slot.decline",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: { label: { type: "string" }, open: { type: "boolean" }, sid: { type: "integer" } },
								required: ["sid", "open", "label"],
								type: "object",
							},
						},
					},
				},
				responses: ok,
			},
		},
	},
} as OpenApiDocument

describe("scenario saved values", () => {
	it("sends a saved number or boolean with its type where a body field names it whole", async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			if (req.url === "/openapi.json") res.end(JSON.stringify(spec))
			else if (req.url === "/v1/slot") res.end(JSON.stringify({ open: true, sid: 7 }))
			else res.end(JSON.stringify({ declined: true }))
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const scenario: Scenario = {
			covers: ["slot.decline"],
			id: "slot",
			steps: [
				{ operationId: "slot.get", saveAs: { open: "$.open", sid: "$.sid" } },
				{ body: { label: "slot {sid}", open: "{open}", sid: "{sid}" }, operationId: "slot.decline" },
			],
		}
		const result = await run({
			baseUrl: url,
			ops: ["slot.decline"],
			principals: { alpha: {} },
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const sent = result.client.transcript.find((exchange) => exchange.operationId === "slot.decline")
		expect(sent?.requestBody).toEqual({ label: "slot 7", open: true, sid: 7 })
	})
})
