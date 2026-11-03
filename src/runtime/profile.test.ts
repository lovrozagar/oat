import { describe, expect, it } from "vitest"
import { op } from "./checks/__fixtures__/harness.ts"
import { BUILTIN_PROFILES, excludedByProfile, externalExcluded, resolveProfile } from "./profile.ts"
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

/* A scenario that calls one operation, then each named external in order. */
const scenario = (...externals: string[]) => ({
	covers: [],
	id: "flow",
	steps: [{ operationId: "a.get" }, ...externals.map((external) => ({ as: "x", external }))],
})

describe("externalExcluded", () => {
	const kinds = { consent: "device", pay: "headless" }
	const profile = { name: "default", spec: { excludeExternalKinds: ["device"] } }

	it("names the first external whose kind the profile excludes", () => {
		expect(externalExcluded(scenario("pay", "consent"), kinds, profile)).toBe(
			'external "consent" is kind "device", which profile "default" excludes',
		)
	})

	it("excludes nothing without kinds, an excluded kind, or an external of one", () => {
		expect(externalExcluded(scenario("consent"), undefined, profile)).toBeNull()
		expect(externalExcluded(scenario("consent"), kinds, { name: "full", spec: {} })).toBeNull()
		expect(externalExcluded(scenario("pay", "unknown"), kinds, profile)).toBeNull()
		expect(externalExcluded(scenario(), kinds, profile)).toBeNull()
	})
})
