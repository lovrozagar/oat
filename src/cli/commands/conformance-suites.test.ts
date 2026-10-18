import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit } from "../__fixtures__/toolkit.ts"
import { runSuites } from "./conformance-suites.ts"

describe("runSuites", () => {
	it("runs every suite in order, the tag unlocks only before a matrix, and counts what failed", async () => {
		const { toolkit, log } = fakeToolkit({ cases: [{ label: "a" }, { failed: true, label: "b" }] })
		const writer = bufferWriter()
		expect(await runSuites(writer, toolkit, false)).toBe(10)
		expect(log).toEqual([
			"parser",
			"example",
			"coverage",
			"tenant",
			"featureGate",
			"rateLimit",
			"unique",
			"seedContract",
			"effects",
			"payloads",
		])
		expect(writer.text()).toContain("  ✗ b\n")
		const before = fakeToolkit()
		await runSuites(bufferWriter(), before.toolkit, true)
		expect(before.log[2]).toBe("unlocks own")
	})
})
