import { describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryReference } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * DISPOSABLE_KILLS_CALLER: the disposable session's logout kills every caller's sessions, and every
 * credential signed in after it too. A renewal refused where the old credential was accepted is a
 * principal the server refuses anywhere: it is BLOCKED after one renewal and one control read, the
 * report says so, and the defect's own finding stays.
 */

const REASON = /signed in again, and the new credential is refused where the old one was accepted \(.+\)/

describe("a principal the server refuses anywhere, after DISPOSABLE_KILLS_CALLER", () => {
	it("is BLOCKED with the control's reason after one renewal, and the defect's finding stays", async () => {
		const reference = await createMemoryReference({ defects: ["DISPOSABLE_KILLS_CALLER"] })
		try {
			const result = await run({
				baseUrl: reference.url,
				network: { fetch: reference.fetch },
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${reference.url}/v1/openapi/spec`,
			})
			const blocked = result.findings.filter((finding) => finding.check === "auth.blocked")
			expect(blocked.length).toBeGreaterThan(0)
			expect(blocked.every((finding) => REASON.test(finding.detail))).toBe(true)
			expect(result.findings.some((finding) => finding.check === "auth.destructive-spares-the-caller")).toBe(true)
			/* The write probes that could not read their target say why. */
			const citing = result.checksSkipped.filter((skipped) =>
				skipped.needs.includes("credential is BLOCKED (signed in again"),
			)
			expect(citing.length).toBeGreaterThan(0)
			const transcript = result.client.transcript
			const kill = transcript.findIndex((exchange) => exchange.operationId === "auth.logout")
			/* Logins that issued a credential: a probe's refused login is not a renewal. */
			const renewals = transcript
				.slice(kill)
				.filter((exchange) => exchange.operationId === "auth.token" && exchange.status === 200)
			expect(renewals.length).toBeGreaterThan(0)
			expect(renewals.length).toBeLessThanOrEqual(Object.keys(PRINCIPALS).length)
		} finally {
			await reference.close()
		}
	}, 600_000)
})

describe("a route that refuses a valid credential, APIKEY_ALTERNATIVE_BROKEN", () => {
	it("blocks nothing: the control read accepts the renewed key, and the defect's finding stays", async () => {
		const reference = await createMemoryReference({ defects: ["APIKEY_ALTERNATIVE_BROKEN"] })
		try {
			const result = await run({
				baseUrl: reference.url,
				network: { fetch: reference.fetch },
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${reference.url}/v1/openapi/spec`,
			})
			expect(result.findings.filter((finding) => finding.check === "auth.blocked")).toEqual([])
			expect(result.findings.some((finding) => finding.check === "auth.alternative-accepted")).toBe(true)
		} finally {
			await reference.close()
		}
	}, 600_000)
})
