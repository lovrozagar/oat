import { describe, expect, it } from "vitest"
import { CHECK_IDS, familyOf } from "../src/runtime/check-ids.ts"
import { type Check, CHECKS, validateRegistry } from "../src/runtime/checks.ts"
import { Client } from "../src/runtime/client.ts"
import { FindingCollector } from "../src/runtime/finding.ts"

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
