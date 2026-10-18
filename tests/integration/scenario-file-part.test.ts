import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A scenario that uploads the same document under two names (a merge, a dedup) names the file it
 * sends: a step body field holding `{ bytes, filename, mediaType }` is that multipart part.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const spec: OpenApiDocument = {
	info: { title: "files", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/extract": {
			post: {
				operationId: "file.extract",
				requestBody: {
					content: {
						"multipart/form-data": {
							schema: {
								properties: { file: { format: "binary", type: "string" }, note: { type: "string" } },
								required: ["file"],
								type: "object",
							},
						},
					},
				},
				responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
} as OpenApiDocument

function file(filename: string) {
	return { bytes: new TextEncoder().encode("%PDF-1.4 invoice INV-100"), filename, mediaType: "application/pdf" }
}

async function serve(received: string[]): Promise<string> {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		let raw = ""
		for await (const chunk of req) raw += chunk
		if (req.url === "/v1/extract") received.push(raw)
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { ok: true }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("a file part in a step body", () => {
	it("is sent as that part, under its own filename", async () => {
		const received: string[] = []
		const url = await serve(received)
		const scenario: Scenario = {
			covers: ["file.extract"],
			id: "merge",
			steps: [
				{ body: { file: file("jan.pdf"), note: "first" }, operationId: "file.extract" },
				{ body: { file: file("feb.pdf"), note: "second" }, operationId: "file.extract" },
			],
		}
		await run({
			baseUrl: url,
			ops: ["file.extract"],
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const scenarioCalls = received.filter((body) => body.includes("invoice INV-100"))
		expect(scenarioCalls).toHaveLength(2)
		expect(scenarioCalls[0]).toContain('filename="jan.pdf"')
		expect(scenarioCalls[0]).toContain("first")
		expect(scenarioCalls[1]).toContain('filename="feb.pdf"')
	})
})
