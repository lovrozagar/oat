import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * What a response must never carry (a session's token, a secret in a data export) is a key that is
 * absent at any depth: no node's text, an object's JSON text included, may contain it.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const spec = {
	info: { title: "export", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/export": {
			get: {
				operationId: "export.get",
				responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
} as unknown as OpenApiDocument

async function serve(body: unknown): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : body))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function status(body: unknown) {
	const url = await serve(body)
	const scenario: Scenario = {
		covers: ["export.get"],
		id: "export",
		steps: [{ assert: { from: "$", omits: '"token":' }, operationId: "export.get" }],
	}
	const result = await run({
		baseUrl: url,
		ops: ["export.get"],
		principals: { alpha: {} },
		scenarios: [scenario],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	return result.scope.operations.find((op) => op.operationId === "export.get")?.status
}

describe("an omits assert", () => {
	it("passes when no node's text holds the value", async () => {
		expect(await status({ profile: { email: "a@x.test" }, sessions: [{ id: "s1" }] })).toBe("passed")
	})

	it("fails when it appears at any depth", async () => {
		expect(await status({ profile: { email: "a@x.test" }, sessions: [{ id: "s1", token: "t" }] })).toBe("failed")
	})
})
