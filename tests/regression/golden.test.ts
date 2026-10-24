import { describe, expect, it, vi } from "vitest"
import {
	CLIENT_ID_ONLY,
	DECLARED_SORT_ONLY,
	defectsFor,
	SQL_ONLY,
	WRITE_ONLY_FIELD_ONLY,
} from "../../src/conformance/matrix/defects.ts"
import { DEFECTS } from "../../src/reference/defects/table.ts"
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
	{ defects: [...WRITE_ONLY_FIELD_ONLY], leg: "clean.write-only-field", target: { shape: "write-only-field" } },
	{ defects: [...DECLARED_SORT_ONLY], leg: "clean.template", target: { dialect: "template" } },
]

/* [case, its leg's clean target, the case's own target] */
type Case = [string, { leg: string; target: GoldenTarget }, GoldenTarget]
const CASES: readonly Case[] = LEGS.flatMap(({ defects, leg, target }) => [
	[leg, { leg, target }, target] as Case,
	...defects.map((name): Case => [name, { leg, target }, { ...target, defects: [name] }]),
])

/* One run, normalized, with its exit code. */
async function goldenReport(target: GoldenTarget): Promise<{ code: number; report: unknown }> {
	const run = await goldenRun(target)
	try {
		return { code: run.code, report: normalize(JSON.parse(await run.read("oat-report.json"))) }
	} finally {
		await removeRun(run)
	}
}

/* A leg's clean run, made once per process on first use, so a defect case filtered on its own
 * still diffs against its leg's clean report. */
const cleanRuns = new Map<string, Promise<{ code: number; report: unknown }>>()
function cleanFor(leg: string, target: GoldenTarget): Promise<{ code: number; report: unknown }> {
	let clean = cleanRuns.get(leg)
	if (clean === undefined) {
		clean = goldenReport(target)
		cleanRuns.set(leg, clean)
	}
	return clean
}

describe("golden reports", () => {
	it("covers every defect", () => {
		const legs = LEGS.map(({ leg }) => leg)
		const defects = Object.keys(DEFECTS).filter((name) => !RACE_TIMED.has(name))
		expect(CASES.map(([name]) => name).toSorted()).toEqual([...legs, ...defects].toSorted())
	})

	it.each(CASES)("%s", async (name, leg, target) => {
		const clean = await cleanFor(leg.leg, leg.target)
		const golden =
			name === leg.leg
				? { exitCode: clean.code, report: clean.report }
				: await goldenReport(target).then(({ code, report }) => ({
						exitCode: code,
						report: delta(clean.report, report) ?? {},
					}))
		await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/golden/${name}.snap`)
	})
})
