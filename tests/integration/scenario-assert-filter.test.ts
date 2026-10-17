import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* A read that lists every topic shows the one this run set by filtering on the id it saved. */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec: OpenApiDocument = {
	info: { title: "assert-filter", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/prefs": {
			get: { operationId: "prefs.get", responses: ok },
			post: {
				operationId: "prefs.set",
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { topic: { type: "string" } }, required: ["topic"], type: "object" },
						},
					},
				},
				responses: ok,
			},
		},
	},
} as OpenApiDocument

describe("scenario assert path", () => {
	it("interpolates {name} in from, so a filter can name what the run saved", async () => {
		let chosen = ""
		const server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			if (req.url === "/openapi.json") {
				res.end(JSON.stringify(spec))
				return
			}
			if (req.method === "POST") {
				let text = ""
				req.on("data", (chunk: Buffer) => {
					text += chunk.toString()
				})
				req.on("end", () => {
					chosen = (JSON.parse(text) as { topic: string }).topic
					res.end(JSON.stringify({ updated: true }))
				})
				return
			}
			const topics = ["t_1", "t_2"].map((id) => ({ id, subscribed: id === chosen }))
			res.end(JSON.stringify({ topics }))
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const scenario: Scenario = {
			covers: ["prefs.set"],
			id: "prefs",
			steps: [
				{ operationId: "prefs.get", saveAs: { topicId: "$.topics[1].id" } },
				{ body: { topic: "{topicId}" }, operationId: "prefs.set" },
				{
					assert: {
						equals: "true",
						from: "$.topics[?(@.id=='{topicId}')].subscribed",
						observes: ["prefs.set"],
					},
					operationId: "prefs.get",
				},
			],
		}
		const result = await run({
			baseUrl: url,
			ops: ["prefs.set"],
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const row = result.scope.operations.find((op) => op.operationId === "prefs.set")
		expect(row?.status).toBe("passed")
		expect(row?.tier).toBe("verified")
	})
})
