import { describe, expect, it } from "vitest"
import { matrixViewFromParts } from "../src/report/matrix.ts"

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
		expect(listNode(matrixViewFromParts(parts([{ origin: "staging" }])))).toBe("held")
	})
})
