import { describe, expect, it } from "vitest"
import { finding } from "./__fixtures__/report.ts"
import { byVerdict, findingSubject, VERDICT_LABEL, VERDICT_NOTE, VERDICT_ORDER } from "./verdicts.ts"

describe("byVerdict", () => {
	it("groups most severe first and leaves empty groups out", () => {
		const bug = finding({ verdict: "BACKEND_BUG" })
		const gap = finding({ verdict: "COVERAGE_GAP" })
		const security = finding({ verdict: "SECURITY" })
		expect(byVerdict([gap, bug, security, bug])).toEqual([
			["SECURITY", [security]],
			["BACKEND_BUG", [bug, bug]],
			["COVERAGE_GAP", [gap]],
		])
		expect(byVerdict([])).toEqual([])
	})

	it("labels and explains every verdict it orders", () => {
		for (const verdict of VERDICT_ORDER) {
			expect(VERDICT_LABEL[verdict].length).toBeGreaterThan(0)
			expect(VERDICT_NOTE[verdict].length).toBeGreaterThan(0)
		}
	})
})

describe("findingSubject", () => {
	it("is the entity, under its origin when there is one", () => {
		expect(findingSubject(finding({ entity: "row" }))).toBe("row")
		expect(findingSubject(finding({ entity: "row", origin: "" }))).toBe("row")
		expect(findingSubject(finding({ entity: "row", origin: "billing" }))).toBe("billing/row")
	})

	it("names the fixture that showed it, unless the entity already names one", () => {
		expect(findingSubject(finding({ entity: "row", fixture: "a.png" }))).toBe("row · a.png")
		expect(findingSubject(finding({ entity: "row", fixture: "" }))).toBe("row")
		expect(findingSubject(finding({ entity: "row · b.png", fixture: "a.png" }))).toBe("row · b.png")
	})
})
