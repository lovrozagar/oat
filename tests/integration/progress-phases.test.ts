import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../../src/runtime/progress.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Progress names the stage a request belongs to. Scenarios and contract calls run after the
 * matrix's fixtures are removed, and they are not teardown: a watcher who reads "teardown" while
 * a scenario waits on a mail is told cleanup is under way when it has not started.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec: OpenApiDocument = {
	info: { title: "phases", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/health": { get: { operationId: "health.get", responses: ok } },
		"/v1/ping": { post: { operationId: "ping.send", responses: ok } },
		"/v1/scene": { get: { operationId: "scene.get", responses: ok } },
	},
} as OpenApiDocument

async function serve(): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { status: "ok" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/* The phase each request to `path` was reported under while it was in flight. */
function phasesOf(snaps: ProgressSnapshot[], path: string): Set<string> {
	return new Set(snaps.filter((snap) => snap.inflight?.url.endsWith(path) === true).map((snap) => snap.phase))
}

describe("progress phases after the matrix", () => {
	it("reports scenario requests as scenario and contract calls as contract, never teardown", async () => {
		const baseUrl = await serve()
		const snaps: ProgressSnapshot[] = []
		await run({
			baseUrl,
			onProgress: (snap) => snaps.push(structuredClone(snap)),
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [{ covers: ["scene.get"], id: "scene", steps: [{ operationId: "scene.get" }] }],
			seed: 1,
			spec: `${baseUrl}/openapi.json`,
		})
		/* Auth probes every read first; what matters is the stage the later calls are shown under. */
		const scene = phasesOf(snaps, "/v1/scene")
		const ping = phasesOf(snaps, "/v1/ping")
		expect(scene).toContain("scenario")
		expect(ping).toContain("contract")
		expect([...scene, ...ping]).not.toContain("teardown")
	})
})
