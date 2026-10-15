import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import type { FenceDecision, FenceRequest } from "../src/config/define-config.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { renderJson, renderMarkdown, type ReportInput } from "../src/report/render.ts"
import { Client } from "../src/runtime/client.ts"
import { EXIT, exitCode } from "../src/runtime/exit.ts"
import { Fence, FencedError } from "../src/runtime/fence.ts"
import { run } from "../src/runtime/run.ts"

/*
 * A hook that sees every request before it leaves the process and may refuse it. A refused
 * request never reaches the backend, is never read as the backend's answer, and is listed in the
 * result; by default it fails the run, because what oat was asked to test was not all tested.
 */

const noDeletes = (request: FenceRequest): FenceDecision =>
	request.method === "DELETE" ? { allow: false, reason: "no deletes on the shared backend" } : { allow: true }

async function runFenced(beforeRequest: (request: FenceRequest) => FenceDecision, failRun?: boolean) {
	const server = await createMemoryServer({})
	try {
		return await run({
			baseUrl: server.url,
			hooks: { beforeRequest },
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...(failRun === undefined ? {} : { fence: { failRun } }),
		})
	} finally {
		await server.close()
	}
}

describe("Client with a fence", () => {
	it("refuses before any I/O and records what it refused", async () => {
		const fence = new Fence(noDeletes)
		/* Nothing listens here: a request that left the process would fail with a network error. */
		const client = new Client("http://127.0.0.1:1")
		client.setFence(fence)
		await expect(client.request("DELETE", "/v1/tables/1")).rejects.toBeInstanceOf(FencedError)
		expect(fence.fenced).toEqual([
			expect.objectContaining({ method: "DELETE", reason: "no deletes on the shared backend" }),
		])
		expect(client.transcript).toEqual([])
	})
})

describe("a run with a fence", () => {
	it("sends no fenced request, reads none as a defect, lists each, and fails the run", async () => {
		const result = await runFenced(noDeletes)
		expect(result.client.transcript.filter((exchange) => exchange.method === "DELETE")).toEqual([])
		expect(
			result.findings.filter((finding) => finding.verdict === "BACKEND_BUG" || finding.verdict === "SECURITY"),
		).toEqual([])
		expect(result.fenced?.requests.length ?? 0).toBeGreaterThan(0)
		expect(result.fenced?.requests.every((request) => request.reason === "no deletes on the shared backend")).toBe(true)
		expect(result.teardown?.failed.some((leftover) => leftover.reason.startsWith("fenced"))).toBe(true)
		expect(exitCode(result)).toBe(EXIT.failed)
	}, 240_000)

	it("leaves the exit code alone when told the fence does not fail the run", async () => {
		const result = await runFenced(noDeletes, false)
		expect(exitCode(result)).not.toBe(EXIT.failed)
	}, 240_000)

	it("blocks an entity whose seeding is fenced", async () => {
		const result = await runFenced((request) =>
			request.method === "POST" && request.operationId === "table.create"
				? { allow: false, reason: "no new tables" }
				: { allow: true },
		)
		expect(
			result.findings.some(
				(finding) => finding.verdict === "BLOCKED" && finding.entity === "table" && finding.check === "world.seed",
			),
		).toBe(true)
		expect(result.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([])
	}, 240_000)
})

describe("the report of a fenced run", () => {
	/* A report needs only what it prints; the rest of a run result is irrelevant here. */
	const input = {
		baseUrl: "http://x.test",
		checksRun: [],
		client: { transcript: [] },
		durationMs: 1,
		entitiesTested: [],
		fenced: {
			failRun: true,
			requests: [
				{
					method: "DELETE",
					operationId: "table.delete",
					phase: "teardown",
					reason: "no deletes",
					url: "http://x.test/v1/tables/1?token=secret",
				},
			],
		},
		findings: [],
		model: { entities: new Map(), operations: [] },
		startedAt: new Date("2026-10-15T00:00:00.000Z"),
	} as unknown as ReportInput

	it("lists every fenced request and fails", () => {
		const md = renderMarkdown(input)
		expect(md).toContain("## Fenced requests")
		expect(md).toMatch(/DELETE .*\/v1\/tables\/1.* · table\.delete · teardown · no deletes/)
		expect(md).not.toContain("secret")
		const json = JSON.parse(renderJson(input)) as { fenced: { requests: unknown[] }; outcome: { exitCode: number } }
		expect(json.fenced.requests).toHaveLength(1)
		expect(json.outcome.exitCode).toBe(EXIT.failed)
	})
})
