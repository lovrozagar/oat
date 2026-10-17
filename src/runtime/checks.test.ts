import { describe, expect, it } from "vitest"
import { type Check, CHECKS, payloadLanes, validateRegistry } from "./checks.ts"
import { CHECK_IDS, familyOf } from "./check-ids.ts"
import { Client } from "./client.ts"
import { FindingCollector } from "./finding.ts"
/*
 * `payload.string-survives` fans its cases across lanes that run together. Written through an
 * update, every lane needs a record of its own: two lanes sharing one read back each other's values
 * and call a correct backend corrupt. When some lane records could not be made, there are fewer
 * lanes, never shared records. Through create, every case is a record of its own.
 */

describe("payloadLanes", () => {
	it("runs no more update lanes than there are records to write", () => {
		expect(payloadLanes({ cases: 30, max: 4, records: 1, viaPatch: true })).toBe(1)
		expect(payloadLanes({ cases: 30, max: 4, records: 3, viaPatch: true })).toBe(3)
		expect(payloadLanes({ cases: 30, max: 4, records: 4, viaPatch: true })).toBe(4)
	})

	it("is bounded by the cases and the cap", () => {
		expect(payloadLanes({ cases: 2, max: 4, records: 4, viaPatch: true })).toBe(2)
		expect(payloadLanes({ cases: 30, max: 4, records: 1, viaPatch: false })).toBe(4)
		expect(payloadLanes({ cases: 0, max: 4, records: 1, viaPatch: false })).toBe(1)
	})
})

const stub = (id: string, dependsOn?: string[]): Check =>
	({
		applicable: () => true,
		id,
		run: async () => {},
		subjects: () => [],
		...(dependsOn === undefined ? {} : { dependsOn }),
	}) as unknown as Check

describe("the check registry", () => {
	it("holds every id it names, once, with each dependency registered earlier", () => {
		expect(() => validateRegistry(CHECKS)).not.toThrow()
		expect(new Set(CHECKS.map((check) => check.id))).toEqual(new Set(CHECK_IDS))
	})

	it("refuses a dependency registered after the check that names it", () => {
		const [first, second] = CHECKS
		if (first === undefined || second === undefined) throw new Error("empty registry")
		const reordered = [stub(first.id, [second.id]), stub(second.id), ...CHECKS.slice(2)]
		expect(() => validateRegistry(reordered)).toThrow(/registered after it/)
	})

	it("refuses a duplicate id and an unregistered one", () => {
		expect(() => validateRegistry([...CHECKS, stub(CHECKS[0]?.id ?? "")])).toThrow(/registered twice/)
		expect(() => validateRegistry(CHECKS.slice(1))).toThrow(/never registered/)
	})

	it("puts every check in a family", () => {
		for (const id of CHECK_IDS) expect(familyOf(id)).toBeTypeOf("string")
	})
})

describe("a check's own findings", () => {
	it("cannot be filed under another check's id", () => {
		const findings = new FindingCollector().ownedBy("sort.order-is-applied")
		expect(() => findings.gap("filter.unknown-field-rejected", "row", "s", "d")).toThrow(/tried to report under/)
		expect(() => findings.unresolved("filter.unknown-field-rejected", "row", "r")).toThrow()
		findings.attributed(["row.list"]).gap("sort.order-is-applied", "row", "s", "d")
		expect(findings.findings).toHaveLength(1)
	})
})

describe("a read-only client", () => {
	it("refuses to send anything that could change server state", async () => {
		const client = new Client("http://127.0.0.1:9").readOnlyView({ check: "sort.order-is-applied" })
		const unsafe = client as unknown as Client
		await expect(unsafe.request("POST", "/rows")).rejects.toThrow(/does not mutate/)
		await expect(unsafe.view({ purpose: "probe" }).request("DELETE", "/rows/1")).rejects.toThrow(/does not mutate/)
	})
})
