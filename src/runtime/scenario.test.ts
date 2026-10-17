import { describe, expect, it } from "vitest"
import type { Scenario } from "../config/types/steps.ts"
import { assertScenarios } from "./scenario.ts"

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
