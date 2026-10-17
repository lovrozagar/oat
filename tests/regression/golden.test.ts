import { describe, expect, it, vi } from "vitest"
import { CLIENT_ID_ONLY, DECLARED_SORT_ONLY, defectsFor, SQL_ONLY } from "../../src/conformance/suite.ts"
import { DEFECTS } from "../../src/reference/defects.ts"
import { delta, type GoldenTarget, goldenRun, normalize, removeRun } from "../support/golden.ts"

/* The run nonce keeps two runs' records apart on a shared backend. Each golden run has a server
 * of its own, so a fixed nonce makes the record names, and so the report, reproducible. */
vi.mock("node:crypto", async (original) => ({
	...(await original<typeof import("node:crypto")>()),
	randomBytes: (size: number) => Buffer.alloc(size, 0xa7),
}))

/* Every defect on the leg that can show it: the memory/postgrest matrix, then the few that need
 * physical columns, a client-id shape or a declared sort grammar. Each leg has a clean run of its
 * own, held in full; a defect's golden is what that defect changed in its leg's clean report. */
/* A defect seen only when two requests land inside the reference server's 15ms read-modify-write
 * window. Under load the window can be missed, so its report is not reproducible; the conformance
 * matrix proves its recall. */
const RACE_TIMED: ReadonlySet<string> = new Set(["CONCURRENT_WRITE_LOST"])

const LEGS: ReadonlyArray<{ leg: string; target: GoldenTarget; defects: readonly string[] }> = [
	{ defects: defectsFor("memory", "postgrest").filter((name) => !RACE_TIMED.has(name)), leg: "clean", target: {} },
	{ defects: [...SQL_ONLY], leg: "clean.sqlite", target: { backend: "sqlite" } },
	{ defects: [...CLIENT_ID_ONLY], leg: "clean.client-ids", target: { shape: "client-ids" } },
	{ defects: [...DECLARED_SORT_ONLY], leg: "clean.template", target: { dialect: "template" } },
]

const CASES: ReadonlyArray<[string, string, GoldenTarget]> = LEGS.flatMap(({ defects, leg, target }) => [
	[leg, leg, target] as [string, string, GoldenTarget],
	...defects.map((name): [string, string, GoldenTarget] => [name, leg, { ...target, defects: [name] }]),
])

const cleanReports = new Map<string, unknown>()

describe("golden reports", () => {
	it("covers every defect", () => {
		const legs = LEGS.map(({ leg }) => leg)
		const defects = Object.keys(DEFECTS).filter((name) => !RACE_TIMED.has(name))
		expect(CASES.map(([name]) => name).toSorted()).toEqual([...legs, ...defects].toSorted())
	})

	it.each(CASES)("%s", async (name, leg, target) => {
		const run = await goldenRun(target)
		try {
			const report = normalize(JSON.parse(await run.read("oat-report.json")))
			if (name === leg) cleanReports.set(leg, report)
			const golden = {
				exitCode: run.code,
				report: name === leg ? report : (delta(cleanReports.get(leg), report) ?? {}),
			}
			await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/golden/${name}.snap`)
		} finally {
			await removeRun(run)
		}
	})
})
