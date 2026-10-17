import { describe, expect, it } from "vitest"
import { leftBehind, unreportedLeftovers } from "../../src/conformance/leaks.ts"
import { PRINCIPALS } from "../../src/conformance/suite.ts"
import { createMemoryServer } from "../../src/reference/http.ts"
import { run } from "../../src/runtime/run.ts"

/*
 * A defect a check catches can still leave records behind: a delete that keeps its row, a write
 * that moves a record out of the caller's reach, a replay that inserts a twin, a job whose receipt
 * names no id. Whatever the defect let through, a record oat leaves behind is one it reports.
 */

async function runWith(defect: string, shape?: string) {
	const server = await createMemoryServer({ defects: [defect], ...(shape === undefined ? {} : { shape }) })
	try {
		const before = await server.snapshot()
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const leaked = leftBehind(before, await server.snapshot())
		return { leaked, result, unreported: unreportedLeftovers(leaked, result.teardown) }
	} finally {
		await server.close()
	}
}

describe("records a defect leaves behind", () => {
	it("include each child a 2xx delete kept, under a parent teardown went on to remove", async () => {
		const { leaked, result, unreported } = await runWith("DELETE_KEEPS_ROW")
		expect(leaked.length).toBeGreaterThan(0)
		expect(unreported).toEqual([])
		expect(result.teardown?.failed.some((failure) => failure.entity === "row")).toBe(true)
	}, 240_000)

	it("include a record an accepted write to an immutable key moved out of reach", async () => {
		const { leaked, result, unreported } = await runWith("IMMUTABLE_WRITABLE")
		expect(leaked.length).toBeGreaterThan(0)
		expect(unreported).toEqual([])
		const moved = result.teardown?.failed.filter((failure) => failure.reason.startsWith("moved by")) ?? []
		expect(moved.length).toBeGreaterThan(0)
	}, 240_000)

	it("include each kept child behind a list that serves fewer rows than asked, unannounced", async () => {
		const { leaked, unreported } = await runWith("DELETE_KEEPS_ROW", "clamped-limit")
		expect(leaked.length).toBeGreaterThan(0)
		expect(unreported).toEqual([])
	}, 240_000)

	it("include a record a key write moved even when the write's answer does not show it", async () => {
		const { leaked, unreported } = await runWith("IMMUTABLE_WRITABLE", "wrapped-records")
		expect(leaked.length).toBeGreaterThan(0)
		expect(unreported).toEqual([])
	}, 240_000)

	it("are none when a replay inserted a twin it never named: the listing named it", async () => {
		const { leaked, unreported } = await runWith("IDEMPOTENT_REPLAY_INSERTS")
		expect(unreported).toEqual([])
		expect(leaked).toEqual([])
	}, 240_000)

	it("include a job whose receipt named no id, reported as unidentified", async () => {
		const { result, unreported } = await runWith("ASYNC_RECEIPT_MISSING_ID")
		expect(unreported).toEqual([])
		expect(result.teardown?.unidentified.some((create) => create.entity === "job")).toBe(true)
	}, 240_000)
})
