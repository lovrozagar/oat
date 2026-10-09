import { describe, expect, it } from "vitest"
import { configProblems } from "../src/config/validate.ts"

const valid = {
	baseUrl: "http://127.0.0.1:8787",
	principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
	spec: "openapi.json",
}

describe("config validation", () => {
	it("accepts a well-formed config", () => {
		expect(configProblems(valid, { forRun: true })).toEqual([])
		expect(configProblems({ ...valid, maxInFlight: 8, network: { retries: 0 }, payloads: "full" })).toEqual([])
	})

	it("names unknown keys and wrong types by path", () => {
		expect(configProblems({ ...valid, concurrency: 4 })).toEqual(["config.concurrency is not a config key"])
		expect(configProblems({ ...valid, maxInFlight: "8" })).toEqual([
			"config.maxInFlight must be an integer of at least 1",
		])
		expect(configProblems({ ...valid, cohortSize: 0 })).toEqual(["config.cohortSize must be an integer of at least 1"])
		expect(configProblems({ ...valid, principals: [{ id: "a", rank: "high" }] })).toEqual([
			"config.principals[0].rank must be a number",
		])
		expect(configProblems({ ...valid, payloads: "some" })).toEqual([
			'config.payloads must be one of "full", "per-write-path"',
		])
	})

	it("requires what a run needs, and only for a run", () => {
		expect(configProblems({ spec: "x" }, { forRun: true })).toEqual([
			"config.baseUrl is required",
			"config.principals is required",
		])
		expect(configProblems({ spec: "x" })).toEqual([])
		expect(configProblems({ ...valid, principals: [] }, { forRun: true })).toEqual(["config.principals is empty"])
	})
})
