import { describe, expect, it } from "vitest"
import { FindingCollector } from "../src/runtime/finding.ts"

describe("finding attribution", () => {
	it("an attributed view shares the collector and stamps its operations", () => {
		const root = new FindingCollector()
		const view = root.attributed(["row.list"])
		view.backend("filter.in-is-union-of-eq", "row", "s", "d", [])
		view.unresolved("sort.order-is-applied", "row", "no field")
		view.gap("world.seed", "row", "s", "d")
		expect(root.findings.map((f) => f.operations)).toEqual([["row.list"], ["row.list"]])
		expect(root.inconclusive).toEqual([
			{ check: "sort.order-is-applied", entity: "row", operations: ["row.list"], reason: "no field" },
		])
	})

	it("an explicit attribution wins over the view's default", () => {
		const root = new FindingCollector()
		root.attributed(["job.start", "job.other"]).attributed(["job.start"]).spec("effects.x", "job", "s", "d", [])
		expect(root.findings[0]?.operations).toEqual(["job.start"])
	})

	it("leaves run-level findings unattributed", () => {
		const root = new FindingCollector()
		root.gap("world.teardown", "run", "s", "d")
		root.unresolved("net", "run", "down")
		expect(root.findings[0]?.operations).toBeUndefined()
		expect(root.inconclusive[0]).toEqual({ check: "net", entity: "run", reason: "down" })
	})

	it("blocked carries evidence", () => {
		const root = new FindingCollector()
		const exchange = { method: "POST", status: 500 } as never
		root.attributed(["row.list"]).blocked("world.seed", "row", "s", "support table.create failed (500)", [exchange])
		expect(root.findings[0]).toMatchObject({
			detail: "blocked by support table.create failed (500)",
			evidence: [exchange],
			operations: ["row.list"],
			verdict: "BLOCKED",
		})
	})
})
