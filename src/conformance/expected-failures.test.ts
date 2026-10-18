import { describe, expect, it } from "vitest"
import { isDefectName } from "../reference/defects/table.ts"
import { DIALECTS } from "../reference/dialect/presets.ts"
import { CHECKS } from "../runtime/checks/registry.ts"
import { EXPECTED_FAILURES, EXPECTED_INCONCLUSIVE } from "./expected-failures.ts"
import { SHAPE_NAMES } from "./shapes.ts"

/*
 * Both lists may only shrink, and an entry that names nothing the suite prints can never be
 * removed by a fix landing: it would sit there excusing nothing, forever.
 */

const BACKENDS = ["memory", "sqlite", "postgres", "d1"]

/** A case name as the shape suite prints it: `shape:<name>`, `recall:<shape>` or `recall:<shape>:<defect>`. */
function printed(key: string): boolean {
	const [kind, shape = "", defect] = key.split(":")
	if (!SHAPE_NAMES.includes(shape)) return false
	if (kind === "shape") return defect === undefined
	return kind === "recall" && (defect === undefined || isDefectName(defect))
}

describe("printed", () => {
	it("knows the names the shape suite prints", () => {
		expect(["shape:uuid-ids", "recall:uuid-ids", "recall:uuid-ids:STALE_LIST"].every(printed)).toBe(true)
		expect(
			["shape:nope", "shape:uuid-ids:STALE_LIST", "recall:uuid-ids:NOT_A_DEFECT", "other:uuid-ids"].some(printed),
		).toBe(false)
	})
})

describe("EXPECTED_FAILURES", () => {
	it("names only cases the suite prints, each with a reason", () => {
		const entries = Object.entries(EXPECTED_FAILURES)
		expect(entries.filter(([key, why]) => !printed(key) || why === "")).toEqual([])
	})
})

describe("EXPECTED_INCONCLUSIVE", () => {
	it("names only legs that run, and checks that exist, as check@entity", () => {
		const checks = new Set<string>(CHECKS.map((check) => check.id))
		const wrong = Object.entries(EXPECTED_INCONCLUSIVE).flatMap(([leg, verdicts]) => {
			const [backend = "", dialect = ""] = leg.split(":")
			const badLeg = (BACKENDS as readonly string[]).includes(backend) && Object.hasOwn(DIALECTS, dialect) ? [] : [leg]
			return [...badLeg, ...verdicts.filter((verdict) => !checks.has(verdict.split("@")[0] ?? ""))]
		})
		expect(wrong).toEqual([])
	})
})
