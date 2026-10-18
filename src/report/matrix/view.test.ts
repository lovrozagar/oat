import { describe, expect, it } from "vitest"
import { report } from "./__fixtures__/reports.ts"
import { NODE_ORDER } from "./catalog.ts"
import { matrixViewFromParts, matrixViewFromReport } from "./view.ts"

const parts = (findings: Array<{ origin?: string }>) => ({
	baseUrl: "http://h.test",
	checksRun: ["list.read-after-write"],
	checksSkipped: [],
	checksSuppressed: [],
	entity: "table",
	findings: findings.map((extra) => ({
		check: "list.read-after-write",
		entity: "table",
		summary: "list projection does not reflect a completed write",
		verdict: "BACKEND_BUG",
		...extra,
	})),
	generatedAt: "2026-10-09T00:00:00Z",
	readSurface: [],
})

const listNode = (view: ReturnType<typeof matrixViewFromParts>) =>
	view.nodes.find((node) => node.id === "list.read-after-write")?.status

describe("the matrix of the primary backend", () => {
	it("shows a primary finding on its entity", () => {
		expect(listNode(matrixViewFromParts(parts([{}])))).toBe("failed")
	})

	it("does not land a secondary origin's finding on a same-named primary entity", () => {
		expect(listNode(matrixViewFromParts(parts([{ origin: "staging" }])))).toBe("passed")
	})
})

describe("matrixViewFromReport", () => {
	it("draws the first tested entity's cells in poster order, with what failed and what waited", () => {
		const view = matrixViewFromReport(
			report({
				cells: { table: { "query.axes-compose": "blocked", "sort.order-is-applied": "failed" } },
				entities: [{ name: "table", readSurface: ["GET /table", "GET /table/{id}"] }, "row"],
			}),
		)
		expect(view).toMatchObject({
			blocked: 1,
			entity: "table",
			failed: 1,
			generatedAt: "2026-10-18T00:00:00.000Z",
			passed: 55,
			readSurface: ["GET /table", "GET /table/{id}"],
			skipped: 0,
		})
		expect(view.nodes.map((node) => node.id)).toEqual(NODE_ORDER.map((cell) => cell.id))
		expect(view.nodes.find((node) => node.id === "sort.order-is-applied")).toEqual({
			hint: "disagreed",
			id: "sort.order-is-applied",
			label: "sort",
			status: "failed",
		})
		expect(view.nodes.find((node) => node.id === "query.axes-compose")).toEqual({
			because: "filter.equality-selects-exactly-one",
			hint: "membership unchanged",
			id: "query.axes-compose",
			label: "filter + sort",
			status: "blocked",
		})
	})

	it("draws a placeholder entity, with no read surface, when the run tested none", () => {
		const view = matrixViewFromReport(report({ entities: ["table"], tested: [] }))
		expect(view).toMatchObject({ entity: "entity", readSurface: [] })
	})
})
