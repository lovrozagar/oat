import { describe, expect, it } from "vitest"
import { configProblems } from "./validate.ts"

const valid = {
	baseUrl: "http://127.0.0.1:8787",
	principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
	spec: "openapi.json",
}

describe("config validation", () => {
	it("accepts a well-formed config", () => {
		expect(configProblems(valid, { forRun: true })).toEqual([])
		expect(
			configProblems({
				...valid,
				keepFixtures: true,
				maxInFlight: 8,
				maxRps: 2.5,
				network: { retries: 0 },
				payloads: "full",
				principals: [{ id: "alpha", rank: 1 }],
			}),
		).toEqual([])
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
})

describe("config validation by kind of key", () => {
	it("names the expected type of every kind of key", () => {
		const wrong = {
			allow: "all",
			baseUrl: 1,
			entities: [],
			fence: null,
			globalHeaders: { accept: 1 },
			hooks: { other: 1, verifyRemoved: "yes" },
			keepFixtures: "no",
			maxRps: 0,
			network: { requestTimeoutMs: -1, retries: undefined },
			principals: [{ id: "a", rank: Number.NaN }],
			seed: 1.5,
		}
		expect(configProblems({ ...valid, ...wrong })).toEqual([
			"config.baseUrl must be a string",
			"config.principals[0].rank must be a number",
			"config.allow must be an array",
			"config.entities must be an object",
			"config.fence must be an object",
			"config.globalHeaders.accept must be a string",
			"config.hooks.verifyRemoved must be a function",
			"config.keepFixtures must be true or false",
			"config.maxRps must be a number above 0",
			"config.network.requestTimeoutMs must be an integer of at least 0",
			"config.seed must be an integer",
		])
		expect(configProblems({ ...valid, hooks: [] })).toEqual(["config.hooks must be an object"])
		expect(configProblems({ ...valid, hooks: { verifyRemoved: () => true } })).toEqual([])
	})

	it("refuses a config that is not an object", () => {
		expect(configProblems(null, { forRun: true })).toEqual(["config must be an object"])
		expect(configProblems({ ...valid, principals: "alpha" }, { forRun: true })).toEqual([
			"config.principals must be an array",
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
