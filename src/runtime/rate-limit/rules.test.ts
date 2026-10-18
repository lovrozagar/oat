import { describe, expect, it } from "vitest"
import { rateLimitedModel } from "./__fixtures__/model.ts"
import { buildRateLimitRules, type CompiledRateLimitRule } from "./rules.ts"

const summary = (rules: CompiledRateLimitRule[]): Array<[string, number, string]> =>
	rules.map((rule) => [rule.category, rule.rps, rule.source])

describe("buildRateLimitRules from tags", () => {
	it("gives each tagged category the smallest rate any of its operations declares", () => {
		const rules = buildRateLimitRules(rateLimitedModel(), undefined)
		expect(summary(rules)).toEqual([
			["items.read", 4, "tag"],
			["items.read", 4, "tag"],
		])
		expect(rules.map((rule) => rule.test("GET", "/x", "items.list"))).toEqual([true, false])
	})

	it("gives no bucket to a category no operation names a rate for", () => {
		const rules = buildRateLimitRules(rateLimitedModel(), [])
		expect(rules.some((rule) => rule.test("POST", "/v1/items", "items.create"))).toBe(false)
		expect(rules.some((rule) => rule.test("DELETE", "/v1/items/1", "items.delete"))).toBe(false)
	})
})

describe("buildRateLimitRules from config", () => {
	it("puts config first, and leaves a tag only the routes config did not cover", () => {
		const rules = buildRateLimitRules(rateLimitedModel(), [{ match: "items.list", rps: 2 }])
		expect(summary(rules)).toEqual([
			["items.list", 2, "config"],
			["items.read", 4, "tag"],
		])
		expect(rules[1]?.test("GET", "/x", "items.get")).toBe(true)
	})

	it("merges a category override into the tag's own bucket", () => {
		const byCategory = buildRateLimitRules(rateLimitedModel(), [{ match: "category:items.read", rps: 3 }])
		expect(summary(byCategory)).toEqual([
			["items.read", 3, "config"],
			["items.read", 3, "config"],
		])
		const joined = buildRateLimitRules(rateLimitedModel(), [
			{ category: "items.read", match: "GET /v1/items/*", rps: 1 },
		])
		expect(summary(joined)).toEqual([
			["items.read", 1, "config"],
			["items.read", 10, "tag"],
		])
	})
})
