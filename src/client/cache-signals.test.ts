import { describe, expect, it } from "vitest"
import { readCacheSignals } from "./cache-signals.ts"

const signals = (headers: Record<string, string>) => readCacheSignals(headers)

describe("readCacheSignals", () => {
	it("reads nothing from an answer that carries no cache headers", () => {
		expect(signals({})).toEqual({ ageS: null, status: [] })
	})

	it("reads Age as whole seconds (RFC 9111) and drops one that is not", () => {
		expect(signals({ age: "42" }).ageS).toBe(42)
		for (const age of ["-1", "1.5", "soon", ""]) expect(signals({ age }).ageS).toBeNull()
	})

	it("reads each cache of a Cache-Status list (RFC 9211), nearest the origin first, with its hit and fwd", () => {
		expect(signals({ "cache-status": 'origin; fwd=uri-miss; stored, "edge cache"; hit; ttl=30' }).status).toEqual([
			{ cache: "origin", fwd: "uri-miss", hit: false },
			{ cache: "edge cache", fwd: null, hit: true },
		])
		expect(signals({ "cache-status": "anyrow; fwd=bypass" }).status).toEqual([
			{ cache: "anyrow", fwd: "bypass", hit: false },
		])
	})

	it("finds the headers whatever their case", () => {
		expect(signals({ Age: "3", "Cache-Status": "edge; hit" })).toEqual({
			ageS: 3,
			status: [{ cache: "edge", fwd: null, hit: true }],
		})
	})

	it("skips a member with no cache name", () => {
		expect(signals({ "cache-status": "; hit, edge; hit" }).status).toEqual([{ cache: "edge", fwd: null, hit: true }])
	})
})
