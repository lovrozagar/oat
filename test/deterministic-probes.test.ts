import { describe, expect, it } from "vitest"
import { judgeDefect, PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

/*
 * What oat sends is a function of its inputs: the same seed and nonce give the same bodies. A salt
 * drawn from the shared transcript, or from a counter every concurrent check advances, made a probe
 * depend on whatever else happened to run — the same run could send a different body, and a
 * verdict could change with the load on the machine.
 */

async function bodiesByCheck(): Promise<Record<string, string[]>> {
	const server = await createMemoryServer({ shape: "client-ids" })
	try {
		const result = await run({
			baseUrl: server.url,
			nonce: "fixed",
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const out: Record<string, string[]> = {}
		for (const exchange of result.client.transcript) {
			if (exchange.check === undefined || exchange.method !== "POST") continue
			;(out[exchange.check] ??= []).push(JSON.stringify(exchange.requestBody))
		}
		for (const bodies of Object.values(out)) bodies.sort()
		return out
	} finally {
		await server.close()
	}
}

describe("the bodies a check sends", () => {
	it("are the same in two runs with the same seed and nonce", async () => {
		const first = await bodiesByCheck()
		const second = await bodiesByCheck()
		expect(Object.keys(first).length).toBeGreaterThan(0)
		expect(second).toEqual(first)
	}, 240_000)
})

describe("recall behind the client-ids shape, under load", () => {
	it("reports CLIENT_ID_IGNORED with only that loss's symptoms, eight runs at once", async () => {
		for (let round = 0; round < 3; round++) {
			const results = await Promise.all(
				Array.from({ length: 8 }, () => judgeDefect("CLIENT_ID_IGNORED", "memory", "postgrest", "client-ids")),
			)
			for (const result of results) {
				expect(result.error).toBeUndefined()
				expect(result.detected).toBe(true)
				expect(result.spurious.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
			}
		}
	}, 600_000)
})
