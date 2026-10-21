import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { leftBehind } from "../../src/conformance/leaks.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"
import { Ledger } from "../../src/runtime/teardown/ledger.ts"
import { referenceToken } from "../support/reference-auth.ts"

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
				security: SECURITY,
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
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const crashed = result.findings.find((finding) => finding.check === "create.does-not-error")
			expect(crashed?.summary).toContain('"unicode" variant')
			expect(result.checksRun.length).toBeGreaterThan(20)
			/* A check that stood down for want of cohort data names the variant that never arrived. */
			expect(result.checksSkipped.some((skip) => skip.needs.includes('missing its "unicode" variant'))).toBe(true)
		} finally {
			await server.close()
		}
	})
})

describe("principals that authenticate with a static key", () => {
	it("have their keys redacted from everything oat writes", async () => {
		const server = await createMemoryServer()
		try {
			/* Each key is a jwt the reference issued, so every request the run sends is accepted. */
			const alpha = await referenceToken(server.url, "key_alpha")
			const beta = await referenceToken(server.url, "key_beta")
			const result = await run({
				baseUrl: server.url,
				only: ["job"],
				principals: {
					alpha: { scope: { project_id: "proj_alpha" }, tenant: "proj_alpha", token: alpha },
					beta: { scope: { project_id: "proj_beta" }, tenant: "proj_beta", token: beta },
				},
				security: { jwt: { static: "{principal.token}" } },
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const scrubbed = result.client.redactor.text(`sent Bearer ${alpha} and ${beta}`)
			expect(scrubbed).not.toContain(alpha)
			expect(scrubbed).not.toContain(beta)
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
			const token = await referenceToken(server.url, "key_alpha")
			const result = await run({
				baseUrl: server.url,
				hooks: {
					/* Good for a second: well inside the renewal buffer, so the next request renews it. */
					resolveCredential: async () => {
						calls += 1
						if (calls > 1) throw new Error("the identity provider is down")
						return { expiresIn: 1, value: token }
					},
				},
				only: ["job"],
				principals: { alpha: { scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" } },
				security: { jwt: { hook: true } },
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			expect(result.findings.some((finding) => finding.check === "auth.blocked" && finding.verdict === "BLOCKED")).toBe(
				true,
			)
		} finally {
			await server.close()
		}
	})
})

describe("a teardown that throws", () => {
	it("is reported, and the run still returns its result", async () => {
		const server = await createMemoryServer()
		const unwind = vi.spyOn(Ledger.prototype, "unwind").mockRejectedValue(new Error("delete exploded"))
		try {
			const result = await run({
				baseUrl: server.url,
				only: ["job"],
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const failed = result.findings.find((finding) => finding.check === "world.teardown")
			expect(failed?.summary).toMatch(/teardown stopped on an unexpected error/)
			expect(result.checksRun.length).toBeGreaterThan(0)
		} finally {
			unwind.mockRestore()
			await server.close()
		}
	})
})

/* A spool folder of a test's own, and the transcript spools in it now. */
function spoolRoot(): { dir: string; spools: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "oat-run-spool-"))
	return { dir, spools: () => readdirSync(dir).filter((name) => name.startsWith("oat-transcript-")) }
}

describe("a run's transcript spool, when the run ends early", () => {
	it("is removed after a run that throws mid-stage", async () => {
		const server = await createMemoryServer()
		const { dir, spools } = spoolRoot()
		try {
			let most = 0
			/* A transport that breaks with an error no stage expects, once the run has spooled. */
			const broken: typeof fetch = (input, init) => {
				most = Math.max(most, spools().length)
				if (most >= 1) throw new TypeError("the transport broke")
				return fetch(input, init)
			}
			const thrown = await run({
				baseUrl: server.url,
				network: { fetch: broken },
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
				transcript: { dir, memoryBytes: 1 },
			}).catch((error: unknown) => error)
			expect(thrown).toBeInstanceOf(Error)
			expect((thrown as Error).message).toContain("the transport broke")
			expect(spools()).toEqual([])
		} finally {
			rmSync(dir, { force: true, recursive: true })
			await server.close()
		}
	})
})
