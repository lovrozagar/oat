import { describe, expect, it } from "vitest"
import { NODE_FLOOR } from "./node-floor.ts"

describe("NODE_FLOOR", () => {
	it("is a major.minor that the runtime under test meets", () => {
		const [major = 0, minor = 0] = NODE_FLOOR.split(".").map(Number)
		const [runningMajor = 0, runningMinor = 0] = process.versions.node.split(".").map(Number)
		expect(NODE_FLOOR).toMatch(/^\d+\.\d+$/)
		expect(runningMajor > major || (runningMajor === major && runningMinor >= minor)).toBe(true)
	})
})
