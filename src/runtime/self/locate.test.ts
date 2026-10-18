import { describe, expect, it } from "vitest"
import { locateProbe, probeStuck } from "./locate.ts"

const nested = (values: unknown[]) => ({ current: values[0], values, where: "nested" as const })

const top = (current: unknown) => ({ current, values: [current], where: "top" as const })

describe("locateProbe", () => {
	it("finds the field at the top, on each nested record, or nowhere", () => {
		expect(locateProbe({ name: "a" }, "name")).toEqual({ current: "a", values: ["a"], where: "top" })
		expect(locateProbe({ x: { name: "a" }, y: { name: "b" }, z: [1], w: null, v: "s" }, "name")).toEqual({
			current: "a",
			values: ["a", "b"],
			where: "nested",
		})
		expect(locateProbe({ x: { other: 1 } }, "name")).toEqual({ current: undefined, values: [], where: "missing" })
		for (const body of [null, "text", [{ name: "a" }]]) {
			expect(locateProbe(body, "name")).toEqual({ current: undefined, values: [], where: "missing" })
		}
	})
})

describe("probeStuck", () => {
	it("sees the value at the top", () => {
		expect(probeStuck(top("a"), top("b"), "b")).toBe(true)
		expect(probeStuck(top("a"), top("a"), "b")).toBe(false)
	})

	it("sees a nested value only when it arrived and something changed", () => {
		expect(probeStuck(nested(["a", "a"]), nested(["b", "a"]), "b")).toBe(true)
		expect(probeStuck(nested(["b", "a"]), nested(["b", "a"]), "b")).toBe(false)
		expect(probeStuck(nested(["a"]), nested(["a"]), "b")).toBe(false)
		expect(probeStuck(nested(["a"]), top("b"), "b")).toBe(false)
	})
})
