import { describe, expect, it } from "vitest"
import { op } from "./checks/__fixtures__/harness.ts"
import { BUILTIN_PROFILES, excludedByProfile, resolveProfile } from "./profile.ts"
import { referenceModel } from "./scope/__fixtures__/models.ts"

describe("resolveProfile", () => {
	it("is the full profile when none is named", () => {
		expect(resolveProfile(undefined, undefined)).toEqual({ name: "full", spec: BUILTIN_PROFILES["full"] })
	})

	it("prefers a configured profile over a built-in of the same name", () => {
		expect(resolveProfile("cheap", { cheap: { maxCost: "medium" } })).toEqual({
			name: "cheap",
			spec: { maxCost: "medium" },
		})
		expect(resolveProfile("cheap", { mine: {} }).spec).toEqual({ maxCost: "low" })
	})

	it("refuses a name nothing defines, listing what is known once", () => {
		expect(() => resolveProfile("nope", { cheap: {}, mine: {} })).toThrow(
			'oat: profile "nope" is not defined. Known: cheap, full, mine',
		)
		expect(() => resolveProfile("nope", undefined)).toThrow('oat: profile "nope" is not defined. Known: cheap, full')
	})
})

describe("excludedByProfile", () => {
	const read = op(referenceModel(), "row.get")
	const costly = { ...read, cost: "high" as const, destructive: true }

	it("names the most direct reason: by name, then destructive, then cost", () => {
		expect(excludedByProfile(costly, { exclude: ["row.get"], excludeDestructive: true, maxCost: "low" })).toBe(
			"excluded by name (operationId: row.get)",
		)
		expect(excludedByProfile(costly, { exclude: ["other"], excludeDestructive: true, maxCost: "low" })).toBe(
			"x-destructive",
		)
		expect(excludedByProfile(costly, { excludeDestructive: false, maxCost: "medium" })).toBe("x-cost: high")
	})

	it("excludes nothing the profile allows", () => {
		expect(excludedByProfile(costly, {})).toBeNull()
		expect(excludedByProfile(costly, { maxCost: "high" })).toBeNull()
		expect(excludedByProfile({ ...costly, destructive: false }, { excludeDestructive: true })).toBeNull()
	})
})
