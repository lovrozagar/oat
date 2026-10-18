import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A scenario step that uploads a file sends its bytes, under the step's media type, exactly as
 * they are — not as JSON, and not with `{name}` filling applied to them.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const spec: OpenApiDocument = {
	info: { title: "byte-body", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/files/{name}": {
			put: {
				operationId: "file.put",
				parameters: [{ in: "path", name: "name", required: true, schema: { type: "string" } }],
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { size: { type: "integer" } }, required: ["size"], type: "object" },
							},
						},
						description: "stored",
					},
				},
			},
		},
	},
} as OpenApiDocument

describe("a byte body in a scenario step", () => {
	it("reaches the server as the same bytes, under the step's media type", async () => {
		const bytes = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3, 87, 69, 66, 80])
		const received: Array<{ type: string | undefined; body: number[] }> = []
		const server = createServer((req, res) => {
			if (req.url === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(spec))
				return
			}
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				const body = Buffer.concat(chunks)
				received.push({ body: [...body], type: req.headers["content-type"] })
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ size: body.length }))
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const scenario: Scenario = {
			covers: ["file.put"],
			id: "upload",
			steps: [
				{
					assert: { equals: String(bytes.length), from: "$.size" },
					bind: { name: "a.webp" },
					body: bytes,
					mediaType: "image/webp",
					operationId: "file.put",
				},
			],
		}
		await run({
			baseUrl: url,
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(received.at(-1)).toEqual({ body: [...bytes], type: "image/webp" })
	})
})
