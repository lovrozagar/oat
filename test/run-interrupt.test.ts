import { describe, expect, it } from "vitest"
import { leftBehind } from "../src/conformance/leaks.ts"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { redactText } from "../src/runtime/redact.ts"
import { run } from "../src/runtime/run.ts"

describe("a run that is stopped", () => {
	it("stops testing, still removes what it made, and says it was interrupted", async () => {
		const server = await createMemoryServer()
		try {
			const before = await server.snapshot()
			const stop = new AbortController()
			const result = await run({
				baseUrl: server.url,
				/* Stop as soon as the second entity starts seeding: the first is fully under way. */
				onProgress: (snap) => {
					if (snap.phase === "seed" && (snap.entityIndex ?? 0) >= 2) stop.abort()
				},
				principals: PRINCIPALS,
				seed: 42,
				signal: stop.signal,
				spec: `${server.url}/v1/openapi/spec`,
			})
			expect(result.interrupted).toBe(true)
			expect(result.findings.some((finding) => finding.check === "run.interrupted")).toBe(true)
			expect(result.created).toBeGreaterThan(0)
			expect(leftBehind(before, await server.snapshot())).toEqual([])
		} finally {
			await server.close()
		}
	})
})

describe("a cohort variant the backend refuses", () => {
	it("is reported, and the rest of the cohort carries on", async () => {
		const server = await createMemoryServer({ defects: ["CREATE_500_ON_NON_ASCII"] })
		try {
			const result = await run({
				baseUrl: server.url,
				only: ["table"],
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const crashed = result.findings.find((finding) => finding.check === "create.does-not-error")
			expect(crashed?.summary).toContain('"unicode" variant')
			expect(result.checksRun.length).toBeGreaterThan(20)
		} finally {
			await server.close()
		}
	})
})

describe("principals that authenticate with a static key", () => {
	it("have their keys redacted from everything oat writes", async () => {
		const server = await createMemoryServer()
		try {
			await run({
				baseUrl: server.url,
				only: ["job"],
				principals: [
					{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { project_id: "proj_alpha" } },
					{ headers: { authorization: "Bearer tok_beta" }, id: "beta", roots: { project_id: "proj_beta" } },
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			expect(redactText("sent Bearer tok_alpha and tok_beta")).not.toMatch(/tok_(alpha|beta)/)
		} finally {
			await server.close()
		}
	})
})

describe("a credential that cannot be renewed", () => {
	it("is reported, and the run still ends cleanly", async () => {
		const server = await createMemoryServer()
		let calls = 0
		try {
			const result = await run({
				baseUrl: server.url,
				hooks: {
					resolvePrincipalAuth: async () => {
						calls += 1
						if (calls > 1) throw new Error("the identity provider is down")
						return { credential: "tok_alpha" }
					},
				},
				only: ["job"],
				principals: [
					{
						auth: { assumeTtlMs: 1, fromHook: "sso", refreshBufferMs: 0 },
						id: "alpha",
						roots: { project_id: "proj_alpha" },
					},
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			expect(result.findings.some((finding) => finding.check === "auth.refresh" && finding.verdict === "BLOCKED")).toBe(
				true,
			)
		} finally {
			await server.close()
		}
	})
})
