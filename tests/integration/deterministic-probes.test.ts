import { describe, expect, it } from "vitest"
import { judgeDefect, PRINCIPALS } from "../../src/conformance/suite.ts"
import { createMemoryServer } from "../../src/reference/http.ts"
import { CHECKS, checkSalts } from "../../src/runtime/checks.ts"
import { run } from "../../src/runtime/run.ts"
import { buildModel } from "../../src/spec/graph.ts"
import { dereference } from "../../src/spec/load.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

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

describe("the salts a check run draws", () => {
	it("are never shared by two checks on the same entity", async () => {
		const server = await createMemoryServer({ shape: "client-ids" })
		let entities: string[]
		try {
			const spec = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
			entities = [...buildModel(dereference(spec).doc).entities.keys()]
		} finally {
			await server.close()
		}
		const seen = new Map<string, string>()
		for (const [entityIndex, entity] of entities.entries()) {
			for (const [checkIndex, check] of CHECKS.entries()) {
				const next = checkSalts(checkIndex, entityIndex)
				for (let draw = 0; draw < 40; draw++) {
					const salt = next()
					expect(seen.get(salt), `${check.id}@${entity} draws ${salt}`).toBeUndefined()
					seen.set(salt, `${check.id}@${entity}`)
				}
			}
		}
		expect(seen.size).toBe(entities.length * CHECKS.length * 40)
	})
})
