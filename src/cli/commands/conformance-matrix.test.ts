import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit, type ToolkitOptions } from "../__fixtures__/toolkit.ts"
import { type Matrix, planPasses, runMatrix } from "./conformance-matrix.ts"

/*
 * The defect matrix: every leg queued at once and printed in order, then what only the whole
 * matrix can judge — the tag unlocks, --ops recall, the shapes and recall behind them, and the
 * checks no defect proved.
 */

const full = (extra: Partial<Matrix> = {}): Matrix => ({
	dialect: undefined,
	jobs: 2,
	only: undefined,
	passes: planPasses(["memory"], undefined, undefined),
	requested: undefined,
	...extra,
})

async function matrix(input: Matrix, options: ToolkitOptions = {}) {
	const { toolkit, log } = fakeToolkit(options)
	const writer = bufferWriter()
	const failures = await runMatrix(writer, toolkit, input)
	return { failures, log, text: writer.text() }
}

describe("planPasses", () => {
	it("runs every backend on the default dialect, and the cheapest on the other shapes", () => {
		expect(
			planPasses(["memory", "sqlite"], undefined, undefined).map((pass) => `${pass.backend}/${pass.dialect}`),
		).toEqual([
			"memory/postgrest",
			"sqlite/postgrest",
			"memory/classic",
			"memory/linked",
			"memory/jsonapi",
			"memory/plain",
			"memory/template",
		])
	})

	it("runs only what a backend or dialect selector asks for", () => {
		expect(planPasses(["sqlite"], "sqlite", undefined)).toEqual([{ backend: "sqlite", dialect: "postgrest" }])
		expect(planPasses(["memory"], undefined, "classic")).toEqual([{ backend: "memory", dialect: "classic" }])
	})
})

describe("runMatrix", () => {
	it("prints each leg in order, sends its defects in chunks, and judges what only the whole matrix can", async () => {
		const { failures, log, text } = await matrix(full(), {
			proven: ["check.a"],
			recall: [
				{ label: "recall:shape:B", problems: [] },
				{ label: "recall:shape:A", problems: ["missed"] },
				{ label: "recall:other:A", problems: [] },
				{ label: "other", problems: [] },
				{ label: "recall:shape:Z", problems: [] },
			],
			shapes: [{ label: "s1", problems: [] }],
			unproven: ["check.a", "check.b", "check.z"],
		})
		expect(text).toContain("── memory · postgrest")
		expect(log.filter((entry) => entry.startsWith("task defects memory/postgrest"))).toEqual([
			"task defects memory/postgrest 6",
			"task defects memory/postgrest 1",
		])
		expect(log).toContain("unlocks matrix")
		expect(log.filter((entry) => entry.startsWith("task scope"))).toHaveLength(2)
		expect(text).toContain("── shapes · memory")
		expect(text).toContain("── recall behind shapes · memory")
		expect(text).toContain("unproven check.a,check.b")
		expect(failures).toBe(2)
		expect(log.at(-1)).toBe("pool closed")
	})

	it("judges no scope, recall or unproven checks for a filtered run, nor shapes off the memory engine", async () => {
		const filtered = await matrix(full({ only: ["A"] }))
		expect(filtered.log.some((entry) => entry.startsWith("task scope") || entry.startsWith("task recall"))).toBe(false)
		expect(filtered.text).not.toContain("unproven")
		const sqlite = await matrix(full({ passes: [{ backend: "sqlite", dialect: "postgrest" }], requested: "sqlite" }))
		expect(sqlite.log).not.toContain("task shapes")
		expect(sqlite.text).not.toContain("── shapes")
	})

	it("judges the tag unlocks itself when no leg runs the default dialect on memory", async () => {
		const { log } = await matrix(full({ dialect: "classic", passes: [{ backend: "memory", dialect: "classic" }] }))
		expect(log).toContain("unlocks own")
		expect(log.some((entry) => entry.startsWith("task scope"))).toBe(false)
	})

	it("closes the pool even when a leg fails", async () => {
		const { toolkit, log } = fakeToolkit()
		const broken = {
			...toolkit,
			suite: {
				...toolkit.suite,
				passAnswer: () => {
					throw new Error("leg broke")
				},
			},
		}
		await expect(runMatrix(bufferWriter(), broken as never, full())).rejects.toThrow("leg broke")
		expect(log.at(-1)).toBe("pool closed")
	})
})
