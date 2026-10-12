import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../src/config/define-config.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * A create that only a mailed token can make (newsletter preferences) belongs to the scenario that
 * holds the token. The matrix must not seed with it: a generated token is refused, and that refusal
 * is no defect and no reason to block what the scenario proves.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const tokenBody = {
	content: {
		"application/json": {
			schema: {
				properties: { token: { type: "string" }, topic: { type: "string" } },
				required: ["token", "topic"],
				type: "object",
			},
		},
	},
}
const pref = { properties: { id: { type: "string" }, topic: { type: "string" } }, required: ["id"], type: "object" }
/* The read lists every topic with a subscribed flag, as a preference page does. */
const prefs = {
	properties: {
		subscriber_id: { type: "string" },
		topics: {
			items: {
				properties: { id: { type: "string" }, subscribed: { type: "boolean" } },
				required: ["id", "subscribed"],
				type: "object",
			},
			type: "array",
		},
	},
	required: ["subscriber_id", "topics"],
	type: "object",
}

const spec: OpenApiDocument = {
	info: { title: "owned-seed", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/prefs": {
			post: {
				operationId: "prefs.set",
				requestBody: tokenBody,
				responses: {
					"201": { content: { "application/json": { schema: pref } }, description: "set" },
					"401": { description: "bad token" },
				},
			},
			/* Untagged, as a real API often is: the model derives the entity from the path. */
			get: {
				operationId: "prefs.get",
				parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }],
				responses: {
					"200": { content: { "application/json": { schema: prefs } }, description: "ok" },
					"401": { description: "bad token" },
				},
			},
		},
	},
} as OpenApiDocument

describe("a create a scenario owns", () => {
	it("is not used to seed the matrix", async () => {
		const sets: string[] = []
		let chosen = ""
		const server = createServer((req, res) => {
			const send = (status: number, body?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(body === undefined ? "" : JSON.stringify(body))
			}
			if (req.url === "/openapi.json") return send(200, spec)
			if (req.method === "POST") {
				let text = ""
				req.on("data", (chunk: Buffer) => {
					text += chunk.toString()
				})
				req.on("end", () => {
					const body = JSON.parse(text) as { token: string; topic: string }
					sets.push(body.token)
					if (body.token !== "mailed") return send(401, { error: "bad token" })
					chosen = body.topic
					send(201, { id: "p_1", topic: body.topic })
				})
				return
			}
			if (req.url === "/v1/prefs?token=mailed") {
				return send(200, { subscriber_id: "s_1", topics: [{ id: "news", subscribed: chosen === "news" }] })
			}
			if (req.url?.startsWith("/v1/prefs?")) return send(401, { error: "bad token" })
			send(404)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const scenario: Scenario = {
			covers: ["prefs.set"],
			id: "prefs",
			steps: [
				{ body: { token: "mailed", topic: "news" }, operationId: "prefs.set" },
				{
					assert: { equals: "true", from: "$.topics[?(@.id=='news')].subscribed", observes: ["prefs.set"] },
					operationId: "prefs.get",
					query: { token: "mailed" },
				},
			],
		}
		const result = await run({
			baseUrl: url,
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(sets).toEqual(["mailed"])
		expect(result.findings.filter((finding) => finding.check === "world.seed")).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "prefs.set")?.status).toBe("passed")
	})
})
