import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/* An operation that documents a redirect answers with the redirect. Following it grades the page at
 * the other end, which the document never described. */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const spec: OpenApiDocument = {
	info: { title: "redirect", version: "1" },
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

describe("documented redirects", () => {
	it("grades the 301 an operation documents instead of the page it points to", async () => {
		const server = createServer((req, res) => {
			if (req.url === "/v1/openapi/spec") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(spec))
				return
			}
			if (req.url === "/v1/reference") {
				res.writeHead(301, { location: "/elsewhere" })
				res.end()
				return
			}
			res.writeHead(200, { "content-type": "text/html" })
			res.end("<html>reference</html>")
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

		const result = await run({
			baseUrl: url,
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})

		const call = result.client.transcript.find((exchange) => exchange.operationId === "reference.open")
		expect(call?.status).toBe(301)
		const row = result.scope.operations.find((op) => op.operationId === "reference.open")
		expect(row?.status).toBe("passed")
		expect(row?.tier).toBe("contract")
	})
})
