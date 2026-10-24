import { describe, expect, it } from "vitest"
import { entityChecks } from "../../runtime/checks/core/registry.ts"
import { CHECKS } from "../../runtime/checks/registry.ts"
import { checkCatalog, NODE_ORDER, STRIPS, USES } from "./catalog.ts"

describe("checkCatalog", () => {
	const catalog = checkCatalog()

	it("tracks every strip's checks once, in strip order, each with its strip", () => {
		const listed = STRIPS.flatMap((strip) => strip.ids)
		expect(catalog.ids).toEqual(listed)
		expect(new Set(listed).size).toBe(listed.length)
		expect(catalog.stripOf.get("sort.order-is-applied")).toMatchObject({ layer: "axis", title: "sort" })
		expect(catalog.stripOf.get("auth.rank-is-monotonic")).toMatchObject({ layer: "auth", title: "who may see it" })
	})

	it("catalogs every poster cell and every composition edge, so a slice has a node for each", () => {
		const ids = new Set(catalog.ids)
		expect(NODE_ORDER.filter((cell) => !ids.has(cell.id))).toEqual([])
		expect(USES.flatMap((use) => [use.from, use.to]).filter((id) => !ids.has(id))).toEqual([])
	})

	it("reads each check's needs from the registry", () => {
		const needy = CHECKS.find((check) => check.needs !== undefined)
		expect(catalog.needs.get(needy?.id ?? "")).toBe(needy?.needs)
		expect(catalog.needs.get("not.a.check")).toBeUndefined()
	})

	it("draws a dependsOn edge per registry dependency, then the composition edges", () => {
		const declared = entityChecks(CHECKS).reduce((n, check) => n + (check.dependsOn?.length ?? 0), 0)
		expect(catalog.edges.filter((e) => e.kind === "dependsOn")).toHaveLength(declared)
		expect(catalog.edges).toContainEqual({
			from: "list.read-after-write",
			kind: "dependsOn",
			to: "create.persists-submitted-fields",
		})
		expect(catalog.edges.slice(-USES.length)).toEqual(USES.map((use) => ({ ...use, kind: "uses" })))
	})
})
