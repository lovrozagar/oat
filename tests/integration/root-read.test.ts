import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import { run } from "../../src/runtime/run/index.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	return {
		...bearerSecurity(),
		info: { title: "root-read", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/overview": {
				get: {
					operationId: "project.overview",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { extractions: { type: "integer" } },
										required: ["extractions"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "root", name: "overview" },
				},
			},
		},
	} as OpenApiDocument
}

async function serve(openToAnonymous: boolean): Promise<string> {
	const document = spec()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document))
			return
		}
		const authed = req.headers.authorization === "Bearer alpha"
		if (!authed && !openToAnonymous) {
			res.writeHead(401, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "unauthorized" }))
			return
		}
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ extractions: 0 }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runOverview(baseUrl: string) {
	return run({
		baseUrl,
		principals: { alpha: { scope: { project_id: "proj_alpha" } } },
		security: { bearer: { static: "alpha" } },
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("caller root read", () => {
	it("reads the caller's project and refuses a missing token", async () => {
		const url = await serve(false)
		const result = await runOverview(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const op = result.scope.operations.find((item) => item.operationId === "project.overview")
		expect(op?.status).toBe("passed")
		const authed = result.client.transcript.find((exchange) => exchange.status === 200)
		expect(authed?.url).toContain("/v1/projects/proj_alpha/overview")
		expect(result.client.transcript.some((exchange) => exchange.status === 401)).toBe(true)
	})

	it("reports a root read that answers with no token", async () => {
		const url = await serve(true)
		const result = await runOverview(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.check)).toContain("read.matches-caller-root")
		expect(result.scope.operations.find((op) => op.operationId === "project.overview")?.status).toBe("failed")
	})
})
