import { describe, expect, it } from "vitest"
import { writerFirst } from "./writer.ts"

describe("writerFirst", () => {
	const principals = { alpha: { key: "a" }, beta: { key: "b" }, gamma: { key: "c" } }

	it("puts the named writer first and keeps every other principal in config order", () => {
		const ordered = writerFirst(principals, "gamma")
		expect(Object.keys(ordered)).toEqual(["gamma", "alpha", "beta"])
		expect(ordered["gamma"]).toBe(principals.gamma)
	})

	it("keeps config order when no writer is named, or the first is", () => {
		expect(Object.keys(writerFirst(principals, undefined))).toEqual(["alpha", "beta", "gamma"])
		expect(Object.keys(writerFirst(principals, "alpha"))).toEqual(["alpha", "beta", "gamma"])
	})
})
