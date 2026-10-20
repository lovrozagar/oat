import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A scenario can belong to a secondary origin: a file store beside the API. Its steps and what it
 * covers are that origin's operations, so it runs where that origin is graded and its passes are
 * that origin's rows.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } })

const mainSpec: OpenApiDocument = {
	info: { title: "main", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/health": {
			get: {
				operationId: "health.get",
				responses: { "200": { content: json({ type: "object" }), description: "ok" } },
			},
		},
	},
} as OpenApiDocument

const tag = { properties: { tag: { type: "string" } }, required: ["tag"], type: "object" }
const fileSpec: OpenApiDocument = {
	info: { title: "files", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/files/{name}": {
			get: {
				operationId: "file.get",
				parameters: [{ in: "path", name: "name", required: true, schema: { type: "string" } }],
				responses: { "200": { content: json(tag), description: "ok" }, "404": { description: "missing" } },
			},
			put: {
				operationId: "file.put",
				parameters: [{ in: "path", name: "name", required: true, schema: { type: "string" } }],
				responses: { "201": { content: json(tag), description: "stored" } },
			},
		},
	},
} as OpenApiDocument

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const send = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

async function servers() {
	const main = await serve((req, res) =>
		req.url === "/openapi.json" ? send(res, 200, mainSpec) : send(res, 200, { status: "ok" }),
	)
	const stored = new Map<string, string>()
	const files = await serve((req, res) => {
		if (req.url === "/openapi.json") return send(res, 200, fileSpec)
		const name = decodeURIComponent((req.url ?? "").replace(/^\/files\//, ""))
		if (req.method === "PUT") {
			stored.set(name, `t-${stored.size + 1}`)
			return send(res, 201, { tag: stored.get(name) })
		}
		const found = stored.get(name)
		return found === undefined ? send(res, 404, {}) : send(res, 200, { tag: found })
	})
	return { files, main }
}

const scenario: Scenario = {
	covers: ["file.put"],
	id: "store",
	origin: "files",
	steps: [
		{ bind: { name: "oat.txt" }, operationId: "file.put", saveAs: { stored: "$.tag" } },
		{
			assert: { equals: "{stored}", from: "$.tag", observes: ["file.put"] },
			bind: { name: "oat.txt" },
			operationId: "file.get",
		},
	],
}

describe("a scenario on a secondary origin", () => {
	for (const ops of [undefined, ["files:file.put"]]) {
		it(`grades that origin's operation${ops === undefined ? "" : " when it is the target"}`, async () => {
			const { files, main } = await servers()
			const result = await run({
				baseUrl: main,
				...(ops === undefined ? {} : { ops }),
				origins: [{ baseUrl: files, id: "files", spec: `${files}/openapi.json` }],
				principals: { alpha: {} },
				scenarios: [scenario],
				seed: 1,
				spec: `${main}/openapi.json`,
			})
			const row = result.scope.operations.find((op) => op.origin === "files" && op.operationId === "file.put")
			expect(row).toMatchObject({ status: "passed", tier: "verified" })
		})
	}
})

/* A main-origin scenario whose support steps reach the file store through the run's origin client. */
const supported: Scenario = {
	covers: ["health.get"],
	id: "health-beside-files",
	steps: [
		{ bind: { name: "a.txt" }, operationId: "file.put", origin: "files" },
		{ bind: { name: "a.txt" }, operationId: "file.get", origin: "files" },
		{ operationId: "health.get" },
	],
}

describe("a run over two origins, its transcript spooled", () => {
	for (const interrupted of [false, true]) {
		it(`leaves no spool behind${interrupted ? " when it is interrupted" : ""}: every client's, the secondary origin's included`, async () => {
			const { files, main } = await servers()
			const dir = mkdtempSync(join(tmpdir(), "oat-origins-spool-"))
			const spools = () => readdirSync(dir).filter((name) => name.startsWith("oat-transcript-"))
			const stop = new AbortController()
			let most = 0
			/* Watches the spool, and stops the run once the file store has answered its support steps. */
			const watched: typeof fetch = async (input, init) => {
				const answer = await fetch(input, init)
				most = Math.max(most, spools().length)
				if (interrupted && String(input).startsWith(`${files}/files/`) && init?.method === "GET") stop.abort()
				return answer
			}
			try {
				const result = await run({
					baseUrl: main,
					network: { fetch: watched },
					origins: [{ baseUrl: files, id: "files", spec: `${files}/openapi.json` }],
					principals: { alpha: {} },
					scenarios: [supported],
					seed: 1,
					signal: stop.signal,
					spec: `${main}/openapi.json`,
					transcript: { dir, memoryBytes: 1 },
				})
				/* The run spooled along the way, so there was something to leave behind. */
				expect([result.interrupted === true, most >= 1]).toEqual([interrupted, true])
				expect(spools()).toEqual([])
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		})
	}
})
