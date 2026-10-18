import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "./harness/launch.ts"
import { runUniqueSuite } from "./unique.ts"

/* A transport that reaches nothing: every run reports why, and the document cases still stand. */
const nowhere: Via = {
	host: () => Promise.reject(new Error("no host")),
	launch: () => Promise.reject(new Error("no reference")),
}

describe("runUniqueSuite", () => {
	it("passes every case against the harness, in process", async () => {
		const results = await runUniqueSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results).toHaveLength(28)
		expect(results[0]?.name).toBe("accepted x-unique shapes parse to column sets")
		expect(results.at(-1)).toEqual({
			detail: "named",
			name: "doctor says unique checks do not run without the tag",
			ok: true,
			why: "TAG_UNLOCKS names the locked checks",
		})
	}, 300_000)

	it("fails each run it could not host, and keeps the cases that need no backend", async () => {
		const results = await runUniqueSuite(nowhere)
		const failed = results.filter((r) => !r.ok)
		expect(failed).toHaveLength(21)
		expect(new Set(failed.map((r) => r.detail))).toEqual(new Set(["no host"]))
		expect(results.slice(0, 6).every((r) => r.ok)).toBe(true)
		expect(results.at(-1)?.ok).toBe(true)
	})
})
