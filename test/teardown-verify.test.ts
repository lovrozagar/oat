import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

/*
 * A delete that answers 2xx proves only that the backend said so. After the unwind oat reads each
 * list once more: a record still listed is a leftover, named with why, so nobody believes a shared
 * backend is clean when it is not. It is a fact about teardown, not a finding — the checks already
 * judge whether delete removes a record.
 */

const STILL_LISTED = "delete answered 2xx but the record is still listed"

async function runAgainst(defects: string[], extra: Record<string, unknown> = {}) {
	const server = await createMemoryServer({ defects })
	try {
		return await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...extra,
		})
	} finally {
		await server.close()
	}
}

describe("teardown verification", () => {
	it("names each record a 2xx delete left in place", async () => {
		const result = await runAgainst(["DELETE_KEEPS_ROW"])
		const kept = result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED) ?? []
		expect(kept.length).toBeGreaterThan(0)
		for (const leftover of kept) {
			expect(result.teardown?.records).toContainEqual({
				entity: leftover.entity,
				id: leftover.id,
				principal: leftover.principal,
				removed: false,
			})
		}
	}, 240_000)

	it("reports nothing when every delete removed its record", async () => {
		const result = await runAgainst([])
		expect(result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED)).toEqual([])
	}, 240_000)

	it("does not read the lists again when told not to", async () => {
		const result = await runAgainst(["DELETE_KEEPS_ROW"], { teardown: { verify: false } })
		expect(result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED)).toEqual([])
	}, 240_000)
})
