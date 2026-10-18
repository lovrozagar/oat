import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import {
	readCost,
	readFeatureGate,
	readFlag,
	readGenerated,
	readImmutable,
	readRateLimit,
	readSoftDelete,
} from "./flags.ts"

const op = (tags: Record<string, unknown>) => tags as OperationObject

describe("single-valued tags", () => {
	it("reads x-soft-delete and x-immutable", () => {
		expect(readSoftDelete(op({ "x-soft-delete": "deleted_at" }))).toBe("deleted_at")
		expect(readSoftDelete(op({ "x-soft-delete": true }))).toBeNull()
		expect(readImmutable(op({ "x-immutable": ["id", 1] }))).toEqual(["id"])
		expect(readImmutable(op({}))).toEqual([])
	})

	it("reads x-generated, else the body's readOnly properties", () => {
		const body = { properties: { a: { readOnly: true }, b: { readOnly: false }, c: null, d: 1 } }
		expect(readGenerated(op({ "x-generated": ["id"] }), body)).toEqual(["id"])
		expect(readGenerated(op({ "x-generated": [] }), body)).toEqual(["a"])
		expect(readGenerated(op({}), null)).toEqual([])
		expect(readGenerated(op({}), "body")).toEqual([])
		expect(readGenerated(op({}), { properties: null })).toEqual([])
		expect(readGenerated(op({}), {})).toEqual([])
	})

	it("reads x-cost and x-feature-gate", () => {
		expect(readCost(op({ "x-cost": "high" }))).toBe("high")
		expect(readCost(op({ "x-cost": "medium" }))).toBe("medium")
		expect(readCost(op({ "x-cost": "huge" }))).toBe("low")
		expect(readFeatureGate(op({ "x-feature-gate": "pro" }))).toBe("pro")
		expect(readFeatureGate(op({ "x-feature-gate": "" }))).toBeNull()
		expect(readFeatureGate(op({ "x-feature-gate": 1 }))).toBeNull()
	})

	it("reads a flag, a malformed one as the caller's fallback", () => {
		expect(readFlag(op({ "x-destructive": true }), "x-destructive")).toBe(true)
		expect(readFlag(op({ "x-destructive": false }), "x-destructive", true)).toBe(false)
		expect(readFlag(op({}), "x-destructive", true)).toBe(false)
		expect(readFlag(op({ "x-destructive": "yes" }), "x-destructive", true)).toBe(true)
		expect(readFlag(op({ "x-destructive": "yes" }), "x-destructive")).toBe(false)
	})

	it("reads x-rate-limit with or without a rate", () => {
		expect(readRateLimit(op({ "x-rate-limit": { category: "search", rps: 5 } }))).toEqual({
			category: "search",
			rps: 5,
		})
		expect(readRateLimit(op({ "x-rate-limit": { category: "search", rps: 0 } }))).toEqual({
			category: "search",
			rps: null,
		})
		expect(readRateLimit(op({ "x-rate-limit": { category: "search" } }))).toEqual({ category: "search", rps: null })
		expect(readRateLimit(op({ "x-rate-limit": { category: "" } }))).toBeNull()
		expect(readRateLimit(op({ "x-rate-limit": null }))).toBeNull()
		expect(readRateLimit(op({ "x-rate-limit": "search" }))).toBeNull()
	})
})
