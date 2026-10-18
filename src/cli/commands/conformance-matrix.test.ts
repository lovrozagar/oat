import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit, type ToolkitOptions } from "../__fixtures__/toolkit.ts"
import { type Leg, type Matrix, planPasses, runMatrix } from "./conformance-matrix.ts"

/*
 * The defect matrix by legs: passes queued at once and printed in order with their time; shapes
 * one per task after the default shape's checks; recall behind each clean shape a chunk at a time,
 * saying on stderr as each shape finishes; `--ops` scope from the default pass's runs.
 */

const memory = { backend: "memory" as const, dialect: "postgrest" }

const matrixOf = (legs: Leg[], extra: Partial<Matrix> = {}): Matrix =>
	Object.assign({ jobs: 2, legs: new Set(legs), only: undefined, passes: [memory], shapes: undefined }, extra)

async function matrix(input: Matrix, options: ToolkitOptions = {}) {
	const { toolkit, log } = fakeToolkit(options)
	const writer = bufferWriter()
	const out = await runMatrix(writer, toolkit, input)
	return { ...out, log, text: writer.text() }
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

describe("runMatrix passes", () => {
	it("prints each pass in order with its time, sends its defects in chunks, and judges the tag unlocks from it", async () => {
		const { failures, log, proven, text } = await matrix(matrixOf(["passes"]), { proven: ["check.a"] })
		expect(text).toMatch(/── memory · postgrest[\s\S]*leg memory\/postgrest 8\n {2}done in [\d.]+s\n/)
		expect(log.filter((entry) => entry.startsWith("task defects"))).toEqual([
			"task defects memory/postgrest 6",
			"task defects memory/postgrest 1",
		])
		expect(log).toContain("unlocks matrix")
		expect(text).toContain("  largest worker: 300 MB\n")
		expect([failures, [...proven]]).toEqual([0, ["check.a"]])
		expect(log.at(-1)).toBe("pool closed")
	})

	it("judges no tag unlocks or scope without the default pass, and nothing for no legs", async () => {
		const classic = await matrix(matrixOf(["passes", "scope"], { passes: [{ backend: "memory", dialect: "classic" }] }))
		expect(classic.log).not.toContain("unlocks matrix")
		expect(classic.log.some((entry) => entry.startsWith("task scope"))).toBe(false)
		const none = await matrix(matrixOf([], { passes: [] }))
		expect(none.text).toBe("")
	})

	it("recalls --ops scope in lanes from the default pass's runs", async () => {
		const { log } = await matrix(matrixOf(["passes", "scope"]), { cases: [{ label: "scope" }] })
		expect(log.filter((entry) => entry.startsWith("task scope"))).toEqual(["task scope 2", "task scope 1"])
	})

	it("closes the pool even when a pass fails", async () => {
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
		await expect(runMatrix(bufferWriter(), broken as never, matrixOf(["passes"]))).rejects.toThrow("leg broke")
		expect(log.at(-1)).toBe("pool closed")
	})
})

describe("runMatrix shapes and recall", () => {
	const shapes = [
		{ label: "shape:prefix", problems: [] },
		{ label: "shape:broken", problems: ["noisy"] },
	]

	it("judges each shape on its own task after the default shape's checks", async () => {
		const { log, text, failures } = await matrix(matrixOf(["shapes"], { passes: [] }), { shapes })
		expect(log.filter((entry) => entry.startsWith("task shape"))).toEqual([
			"task shape-reference",
			"task shape prefix",
			"task shape broken",
		])
		expect(text).toContain("── shapes · memory")
		expect(text).not.toContain("recall behind")
		expect(failures).toBe(1)
	})

	it("judges only the shapes asked for", async () => {
		const { log } = await matrix(matrixOf(["shapes"], { passes: [], shapes: ["broken"] }), { shapes })
		expect(log.filter((entry) => entry.startsWith("task shape "))).toEqual(["task shape broken"])
	})

	it("recalls a chunk of defects per task behind each clean shape, and waits on one that is not", async () => {
		const recallDefects = ["A", "B", "C", "D", "E", "F", "G"]
		const writer = bufferWriter()
		const { toolkit, log } = fakeToolkit({ recallDefects, recallProblems: { C: ["missed"] }, shapes })
		const { proven, failures } = await runMatrix(writer, toolkit, matrixOf(["recall"], { passes: [] }))
		expect(log.filter((entry) => entry.startsWith("task recall"))).toEqual([
			"task recall prefix 6",
			"task recall prefix 1",
		])
		expect(writer.text()).toMatch(/ {2}recall behind prefix: 7 case\(s\), 1 not as expected · [\d.]+s\n/)
		expect(writer.text()).toContain("── recall behind shapes · memory")
		expect([...proven].sort()).toEqual(["check.a", "check.b"])
		/* The broken shape's own case, its waiting recall case, and the missed defect. */
		expect(failures).toBe(3)
	})
})
