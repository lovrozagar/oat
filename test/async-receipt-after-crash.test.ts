import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { type PrincipalSpec, run } from "../src/runtime/run.ts"

/*
 * An action that crashes never hands back a receipt, so the receipt check cannot judge it. It
 * must say so: a check that goes quiet reads exactly like one that passed. The crash itself is
 * failed by the server-error rule.
 */
describe("async.receipt-identifies-the-job when the action crashes", () => {
	it("states that no receipt could be read, and the crash is failed", { timeout: 60_000 }, async () => {
		const server = await createMemoryServer({ defects: ["ACTION_CRASHES", "ASYNC_RECEIPT_MISSING_ID"] })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS as PrincipalSpec[],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const said = result.inconclusive.find((entry) => entry.check === "async.receipt-identifies-the-job")
			expect(said?.reason).toMatch(/no receipt/)
			expect(result.findings.some((f) => f.check === "response.no-server-error")).toBe(true)
		} finally {
			await server.close()
		}
	})
})

/* A job that never started cannot be watched to its end: the lifecycle check must say why. */
describe("async.reaches-terminal-state when the action crashes", () => {
	it("states that no job was started", { timeout: 60_000 }, async () => {
		const server = await createMemoryServer({ defects: ["ACTION_CRASHES", "ASYNC_NEVER_COMPLETES"] })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS as PrincipalSpec[],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const said = result.inconclusive.find((entry) => entry.check === "async.reaches-terminal-state")
			expect(said?.reason).toMatch(/no job/)
		} finally {
			await server.close()
		}
	})
})
