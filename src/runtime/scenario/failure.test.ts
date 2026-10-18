import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { blamed, failureOf, ScenarioStopped, StepFailure } from "./failure.ts"

describe("failureOf", () => {
	it("keeps a step's own failure, and wraps anything else with no evidence", () => {
		const own = new StepFailure("refused", [exchange("GET", "/a", { status: 403 })], ["a.get"])
		expect(failureOf(own)).toBe(own)
		expect(failureOf(new Error("boom"))).toMatchObject({ blames: [], evidence: [], message: "boom" })
		expect(failureOf("text")).toMatchObject({ blames: [], evidence: [], message: "text" })
	})
})

describe("ScenarioStopped / blamed", () => {
	it("names a stop, and blames the step's operation when it has one", () => {
		expect(new ScenarioStopped().name).toBe("ScenarioStopped")
		expect(blamed("a.get")).toEqual(["a.get"])
		expect(blamed(undefined)).toEqual([])
	})
})
