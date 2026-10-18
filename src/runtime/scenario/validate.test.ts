import { describe, expect, it } from "vitest"
import type { Scenario } from "../../config/types/steps.ts"
import { assertScenarios, isExternal, isOutOfBand, scenarioCheckId, stepOperation } from "./validate.ts"

/*
 * A scenario may step onto another origin — upload a file to the cdn, then commit it through the
 * API. The step names the operation as that origin's document has it, and is checked there.
 */

const documents: Record<string, Set<string>> = {
	cdn: new Set(["cdn.upload"]),
	main: new Set(["avatar.commit"]),
}
const known = (id: string, origin?: string) => documents[origin ?? "main"]?.has(id) === true

const scenario = (steps: Scenario["steps"]): Scenario => ({ covers: ["avatar.commit"], id: "upload", steps })

describe("scenario steps on another origin", () => {
	it("are checked against that origin's document", () => {
		expect(() =>
			assertScenarios(
				[scenario([{ operationId: "cdn.upload", origin: "cdn" }, { operationId: "avatar.commit" }])],
				known,
			),
		).not.toThrow()
	})

	it("are refused when that origin does not have the operation", () => {
		expect(() => assertScenarios([scenario([{ operationId: "avatar.commit", origin: "cdn" }])], known)).toThrow(
			/avatar\.commit/,
		)
	})

	it("do not count toward covering a main operation of the same name", () => {
		expect(() => assertScenarios([scenario([{ operationId: "avatar.commit", origin: "cdn" }])], () => true)).toThrow(
			/covers avatar\.commit but no step calls it/,
		)
	})
})

/* The main document has every `notes.` operation. */
const main = (id: string) => id.startsWith("notes.")

describe("assertScenarios", () => {
	it("refuses two scenarios with one id", () => {
		const same = scenario([{ operationId: "notes.list" }])
		expect(() =>
			assertScenarios(
				[
					{ ...same, covers: [] },
					{ ...same, covers: [] },
				],
				main,
			),
		).toThrow('oat: two scenarios share the id "upload"')
	})

	it("refuses a step the main document does not have", () => {
		expect(() => assertScenarios([{ covers: [], id: "x", steps: [{ operationId: "ghost.op" }] }], main)).toThrow(
			'oat: scenario "x" calls ghost.op, which is not in the document',
		)
	})

	it("takes a step with no operation, or an empty origin, as the main document's", () => {
		expect(() =>
			assertScenarios(
				[
					{
						covers: ["notes.list"],
						id: "x",
						steps: [
							{ method: "GET", path: "/health" },
							{ outOfBand: { address: "a@b.c", as: "code", kind: "otp" } },
							{ external: "pay", as: "paid" },
							{ operationId: "notes.list", origin: "" },
						],
					},
				],
				main,
			),
		).not.toThrow()
	})
})

describe("scenarioCheckId / step kinds", () => {
	it("names the check and tells the step kinds apart", () => {
		expect(scenarioCheckId({ covers: [], id: "rename", steps: [] })).toBe("scenario.rename")
		expect(isExternal({ as: "x", external: "pay" })).toBe(true)
		expect(isExternal({ operationId: "a" })).toBe(false)
		expect(isOutOfBand({ outOfBand: { address: "a", as: "b", kind: "c" } })).toBe(true)
		expect(isOutOfBand({ operationId: "a" })).toBe(false)
		expect(stepOperation({ operationId: "a" })).toBe("a")
		expect(stepOperation({ method: "GET", path: "/" })).toBeUndefined()
	})
})
