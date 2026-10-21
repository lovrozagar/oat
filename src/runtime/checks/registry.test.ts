import { describe, expect, it } from "vitest"
import { CHECK_IDS, familyOf } from "../check-ids.ts"
import { entityChecks, validateRegistry } from "./core/registry.ts"
import { CHECKS } from "./registry.ts"

/*
 * The registry is the run order. Every check id is there once, each after the checks it depends
 * on, so cascade suppression has their results to consult; the foundations come first and the
 * checks that judge the whole transcript come last, after everything that writes to it.
 */

const at = (id: string): number => CHECKS.findIndex((check) => check.id === id)

describe("the check registry", () => {
	it("holds every id it names, once, with each dependency registered earlier", () => {
		expect(() => validateRegistry(CHECKS)).not.toThrow()
		expect(new Set(CHECKS.map((check) => check.id))).toEqual(new Set(CHECK_IDS))
		expect(CHECKS).toHaveLength(CHECK_IDS.length)
	})

	it("puts every check in a family", () => {
		for (const id of CHECK_IDS) expect(familyOf(id)).toBeTypeOf("string")
	})

	it("runs the foundations before the checks that rely on them", () => {
		expect(at("create.keeps-submitted-identity")).toBe(0)
		expect(at("list.read-after-write")).toBeLessThan(at("filter.equality-selects-exactly-one"))
		expect(at("pagination.page-walk-covers-set")).toBeLessThan(at("sort.reverse-symmetry"))
	})

	it("judges the transcript last, after every check that writes to it", () => {
		const last = CHECKS.slice(-3).map((check) => check.id)
		expect(last).toEqual([
			"response.status-is-documented",
			"schema.error-response-matches-document",
			"spec.declared-rate-limit-is-honoured",
		])
		for (const check of entityChecks(CHECKS).slice(-3)) expect(check.judgesTranscript).toBe(true)
	})
})
