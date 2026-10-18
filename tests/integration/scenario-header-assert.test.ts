import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* A redirect says what it means in a header. An assert reads the same addresses saveAs does. */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const spec: OpenApiDocument = {
	info: { title: "header-assert", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/reference": {
			get: {
				operationId: "reference.open",
				responses: {
					"301": {
						description: "moved",
						headers: { Location: { schema: { format: "uri", type: "string" } } },
					},
				},
			},
		},
	},
} as OpenApiDocument

async function serve(location: string): Promise<string> {
	const server = createServer((req, res) => {
		if (req.url === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(spec))
			return
		}
		res.writeHead(301, { location })
		res.end()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const REFERENCE: Scenario = {
	covers: ["reference.open"],
	id: "reference",
	steps: [
		{
			assert: { equals: "https://docs.example/api", from: "header:location" },
			expect: [301],
			operationId: "reference.open",
		},
	],
}

async function grade(location: string) {
	const url = await serve(location)
	const result = await run({
		baseUrl: url,
		ops: ["reference.open"],
		principals: [{ headers: {}, id: "alpha" }],
		scenarios: [REFERENCE],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	return result.scope.operations.find((op) => op.operationId === "reference.open")
}

describe("scenario assert on a header", () => {
	it("verifies a redirect by the Location it answers with", async () => {
		const row = await grade("https://docs.example/api")
		expect(row?.status).toBe("passed")
		expect(row?.tier).toBe("verified")
	})

	it("fails a redirect that points somewhere else", async () => {
		const row = await grade("https://elsewhere.example/")
		expect(row?.status).toBe("failed")
	})
})
