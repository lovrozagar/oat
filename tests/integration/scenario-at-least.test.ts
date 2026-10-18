import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A count read from a sampled or eventually consistent store promises a floor, not an exact
 * number: a usage chart may weigh one kept event for the two it dropped.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const json = (schema: unknown) => ({ "application/json": { schema } })
const spec = {
	info: { title: "usage", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/ping": {
			post: {
				operationId: "ping.send",
				responses: { "200": { content: json({ type: "object" }), description: "ok" } },
			},
		},
		"/v1/usage": {
			get: {
				operationId: "usage.get",
				responses: {
					"200": { content: json({ properties: { total: { type: "number" } }, type: "object" }), description: "ok" },
				},
			},
		},
	},
} as unknown as OpenApiDocument

/* Keeps every other ping and counts each kept one twice, as a sampled store estimates. */
async function serve(): Promise<string> {
	let pings = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const send = (value: unknown) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(value))
		}
		if (req.url === "/openapi.json") return send(spec)
		if (req.url === "/v1/ping") {
			pings += 1
			return send({ ok: true })
		}
		if (req.url === "/v1/usage") return send({ total: Math.floor(pings / 2) * 2 })
		res.writeHead(404)
		res.end()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function scenario(atLeast: number): Scenario {
	return {
		covers: ["ping.send", "usage.get"],
		id: "usage",
		steps: [
			{ operationId: "ping.send" },
			{ operationId: "ping.send" },
			{ operationId: "ping.send" },
			{ assert: { atLeast, from: "$.total", observes: ["ping.send"] }, operationId: "usage.get" },
		],
	}
}

async function runScenario(atLeast: number) {
	const url = await serve()
	return run({
		baseUrl: url,
		ops: ["ping.send", "usage.get"],
		principals: [{ headers: {}, id: "alpha" }],
		scenarios: [scenario(atLeast)],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("an atLeast assert", () => {
	it("passes a count at or above the floor and records the number it saw", async () => {
		const result = await runScenario(1)
		const ping = result.scope.operations.find((op) => op.operationId === "ping.send")
		expect(ping?.status).toBe("passed")
		expect(ping?.tier).toBe("verified")
		expect(ping?.evidence?.observation).toMatchObject({ path: "$.total", value: "2" })
	})

	it("fails a count below the floor", async () => {
		const result = await runScenario(3)
		expect(result.scope.operations.find((op) => op.operationId === "ping.send")?.status).toBe("failed")
	})
})
