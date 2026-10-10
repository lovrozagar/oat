import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { PRINCIPALS, judgeDefect } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function profileSpec(): OpenApiDocument {
	const profile = {
		properties: { first_name: { maxLength: 64, type: "string" } },
		type: "object",
	}
	return {
		info: { title: "self", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": {
							content: { "application/json": { schema: profile } },
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: {
						content: { "application/json": { schema: profile } },
						required: true,
					},
					responses: {
						"200": {
							content: { "application/json": { schema: profile } },
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
			},
		},
	} as OpenApiDocument
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString("utf8")
	if (text === "") return undefined
	return JSON.parse(text) as unknown
}

async function serve(mode: "hold" | "open" | "forget"): Promise<string> {
	let first = "Ada"
	const spec = profileSpec()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				const text = JSON.stringify(spec)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(text)
				return
			}
			if (url.pathname === "/v1/me") {
				const authorized = req.headers.authorization === "Bearer alpha"
				if (!authorized && mode !== "open") {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ first_name: first }))
					return
				}
				if (method === "PATCH") {
					const body = (await readBody(req)) as { first_name?: unknown }
					if (mode !== "forget" && typeof body.first_name === "string") first = body.first_name
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ first_name: mode === "forget" ? "Ada" : first }))
					return
				}
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runProfile(baseUrl: string) {
	return run({
		baseUrl,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("identity self", () => {
	it("reads the caller, sees an update stick, and refuses a missing token", async () => {
		const url = await serve("hold")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.entitiesTested).toEqual(["profile"])
		const read = result.scope.operations.find((op) => op.operationId === "profile.read")
		const update = result.scope.operations.find((op) => op.operationId === "profile.update")
		expect(read?.status).toBe("held")
		expect(update?.status).toBe("held")
		expect(read?.checks.held).toContain("auth.self-is-the-caller")
		const anonymous = result.client.transcript.find((exchange) => exchange.status === 401)
		expect(anonymous?.requestHeaders.authorization).toBeUndefined()
	})

	it("reports a caller route that answers with no token", async () => {
		const url = await serve("open")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.check)).toContain("auth.self-is-the-caller")
		expect(result.scope.operations.find((op) => op.operationId === "profile.read")?.status).toBe("failed")
	})

	it("reports an update the next read does not show", async () => {
		const url = await serve("forget")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary)).toContain("an update to the caller did not stick")
		expect(result.scope.operations.find((op) => op.operationId === "profile.update")?.status).toBe("failed")
	})

	it("the reference backend is caught only when the caller update does not stick", async () => {
		const dropped = await judgeDefect("CALLER_UPDATE_DROPPED", "memory", "postgrest")
		expect(dropped.error).toBeUndefined()
		expect(dropped.detected).toBe(true)
		expect(dropped.spurious).toEqual([])
	})

	it("an untagged reference does not blame the caller routes", async () => {
		const server = await createMemoryServer({ untagged: true })
		open.push(server)
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const blamed = result.findings.filter(
			(finding) =>
				DEFECT_VERDICTS.has(finding.verdict) &&
				(finding.entity === "profile" || finding.entity === "me" || finding.check === "auth.self-is-the-caller"),
		)
		expect(blamed).toEqual([])
	})
})
