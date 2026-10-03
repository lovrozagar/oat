import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer, type ReferenceServer } from "../src/reference/http.ts"
import { run, type RunResult } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

async function reference(defects: string[] = []): Promise<ReferenceServer> {
	const server = await createMemoryServer({ defects })
	open.push(server)
	return server
}

/** Forwards to the reference server, failing any request `fail` matches with a 500. */
async function failing(target: ReferenceServer, fail: (method: string, path: string) => boolean): Promise<string> {
	const upstream = new URL(target.url)
	const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
		const path = req.url ?? "/"
		if (fail(req.method ?? "GET", path.split("?")[0] ?? path)) {
			req.resume()
			res.writeHead(500, { "content-type": "application/json" })
			res.end(JSON.stringify({ error_key: "internal", message: "injected" }))
			return
		}
		const forward = httpRequest(
			{ headers: req.headers, hostname: upstream.hostname, method: req.method, path, port: upstream.port },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers)
				answer.pipe(res)
			},
		)
		req.pipe(forward)
	})
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => proxy.close(() => resolve())) })
	return url
}

async function runAt(baseUrl: string, ops?: string[]): Promise<RunResult> {
	return run({
		baseUrl,
		principals: PRINCIPALS,
		seed: 42,
		spec: `${baseUrl}/v1/openapi/spec`,
		...(ops === undefined ? {} : { ops }),
	})
}

const defects = (result: RunResult) => result.findings.filter((f) => DEFECT_VERDICTS.has(f.verdict))
const coverage = (result: RunResult, operationId: string) =>
	result.scope.operations.find((op) => op.operationId === operationId)

describe("targeted runs", () => {
	it("a full run reports coverage for every operation", async () => {
		const server = await reference()
		const result = await runAt(server.url)
		expect(result.scope.mode).toBe("full")
		expect(defects(result)).toEqual([])
		expect(coverage(result, "table.get")?.status).toBe("held")
		expect(coverage(result, "row.list")?.status).toBe("held")
		expect(coverage(result, "auth.token")).toMatchObject({ status: "untested" })
		expect(coverage(result, "auth.token")?.reason).toMatch(/^unmodeled:/)
	})

	it("does not grade an operation outside the targets", async () => {
		const server = await reference(["PATCH_REPLACES"])
		const result = await runAt(server.url, ["table.list"])
		expect(result.scope.mode).toBe("targeted")
		expect(defects(result)).toEqual([])
		expect(result.scope.operations.map((op) => op.operationId)).toEqual(["table.list"])
		expect(coverage(result, "table.list")?.status).toBe("held")
		expect(result.checksRun).not.toContain("patch.minimality")
		expect(result.scope.support.map((op) => op.operationId)).toContain("table.create")
	})

	it("grades a target and attributes its findings to it", async () => {
		const server = await reference(["PATCH_REPLACES"])
		const result = await runAt(server.url, ["table.update"])
		const found = defects(result)
		expect(found.map((f) => f.check)).toContain("patch.minimality")
		expect(found.every((f) => f.operations?.includes("table.update"))).toBe(true)
		expect(coverage(result, "table.update")?.status).toBe("failed")
		expect(coverage(result, "table.update")?.checks.failed).toContain("patch.minimality")
	})

	it("skips the costly operations of a queued entity that are not targets", async () => {
		const server = await reference()
		const result = await runAt(server.url, ["job.list"])
		const started = result.client.transcript.filter((e) => e.method === "POST" && e.url.endsWith("/jobs/start"))
		expect(started).toEqual([])
		expect(result.checksRun).not.toContain("async.reaches-terminal-state")
		expect(coverage(result, "job.list")?.status).toBe("held")
	})

	it("reports an unreachable target as untested with the reason", async () => {
		const server = await reference()
		const result = await runAt(server.url, ["auth.token"])
		expect(result.entitiesTested).toEqual([])
		expect(coverage(result, "auth.token")).toMatchObject({ status: "untested" })
		expect(coverage(result, "auth.token")?.reason).toMatch(/^unmodeled:/)
	})

	it("blocks a target whose support operation fails, without calling it a defect", async () => {
		const server = await reference()
		const url = await failing(server, (method, path) => method === "POST" && path.endsWith("/tables"))
		const result = await runAt(url, ["row.list"])
		expect(defects(result)).toEqual([])
		expect(coverage(result, "row.list")?.status).toBe("blocked")
		const blocked = result.findings.find((f) => f.verdict === "BLOCKED" && f.operations?.includes("row.list"))
		expect(blocked?.detail).toMatch(/table\.create/)
		expect(blocked?.evidence.some((e) => e.status === 500)).toBe(true)
	})

	it("still reports a failing create as a defect when the create is the target", async () => {
		const server = await reference()
		const url = await failing(server, (method, path) => method === "POST" && path.endsWith("/tables"))
		const result = await runAt(url, ["table.create"])
		expect(defects(result).map((f) => f.check)).toContain("create.does-not-error")
		expect(coverage(result, "table.create")?.status).toBe("failed")
	})

	it("routes an origin-prefixed target to that origin only", async () => {
		const primary = await reference(["PATCH_REPLACES"])
		const cdn = await reference(["PATCH_REPLACES"])
		const result = await run({
			baseUrl: primary.url,
			ops: ["cdn:table.update"],
			origins: [{ baseUrl: cdn.url, id: "cdn", spec: `${cdn.url}/v1/openapi/spec` }],
			principals: PRINCIPALS,
			seed: 42,
			spec: `${primary.url}/v1/openapi/spec`,
		})
		expect(result.entitiesTested).toEqual(["cdn:table"])
		expect(result.scope.operations.map((op) => [op.origin, op.operationId, op.status])).toEqual([
			["cdn", "table.update", "failed"],
		])
		expect(defects(result).every((f) => f.origin === "cdn")).toBe(true)
	})

	it("does not run an origin no target names", async () => {
		const primary = await reference()
		const cdn = await reference()
		const result = await run({
			baseUrl: primary.url,
			ops: ["table.get"],
			origins: [{ baseUrl: cdn.url, id: "cdn", spec: `${cdn.url}/v1/openapi/spec` }],
			principals: PRINCIPALS,
			seed: 42,
			spec: `${primary.url}/v1/openapi/spec`,
		})
		expect(result.scope.originsSkipped).toEqual(["cdn"])
		expect(result.entitiesTested.some((name) => name.startsWith("cdn:"))).toBe(false)
	})

	it("does not count an operation as graded when no check exercised it", async () => {
		const server = await reference()
		/* One principal: the invite flow needs a peer, so nothing ever calls table.revoke. The
		 * transcript-judging status check runs on the entity but has nothing of revoke to judge. */
		const result = await run({
			baseUrl: server.url,
			ops: ["table.revoke"],
			principals: PRINCIPALS.slice(0, 1),
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.client.transcript.some((e) => e.method === "DELETE" && e.url.includes("/grants/"))).toBe(false)
		expect(coverage(result, "table.revoke")?.status).toBe("untested")
		expect(coverage(result, "table.revoke")?.checks.held).toEqual([])
	})

	it("rejects an unknown target before any request", async () => {
		const server = await reference()
		await expect(runAt(server.url, ["table.craete"])).rejects.toThrow(/Did you mean: table\.create/)
	})
})
