import { describe, expect, it } from "vitest"
import { documentProblems } from "./document.ts"

/* What a config asks of a document beyond its recipes: no removed tag, and scenario schemes it declares. */

const view = (schemes: string[], authFlows = false) => ({
	authFlows,
	schemes: new Map(schemes.map((name) => [name, {}])),
})
const PRIMARY = view(["apiKey", "jwt"])
const ORIGINS = { cdn: view(["cdnKey"]) }

/* A config reading the version from a path under `scheme`. */
const versionRead = (scheme: unknown) => ({ targetVersion: { from: "$.v", path: "/version", scheme } })

describe("documentProblems", () => {
	it("says the removed x-auth-flows tag is no longer read", () => {
		expect(documentProblems({}, view([], true))).toEqual([
			"the document's x-auth-flows tag is no longer read: declare a security.<scheme> recipe in config",
		])
	})

	it("accepts a step scheme the step's document declares, the origin's for a step on an origin", () => {
		const scenarios = [
			{ id: "s1", steps: [{ operationId: "a", scheme: "jwt" }, { outOfBand: { address: "a", as: "t", kind: "otp" } }] },
			{ id: "s2", origin: "cdn", steps: [{ operationId: "b", scheme: "cdnKey" }] },
			{ id: "s3", steps: [{ operationId: "c", origin: "cdn", scheme: "cdnKey" }] },
		]
		expect(documentProblems({ scenarios }, PRIMARY, ORIGINS)).toEqual([])
	})

	it("names the scenario, the step and the scheme no document of it declares, with did-you-mean", () => {
		const scenarios = [
			{ id: "s1", steps: [{ operationId: "a" }, { operationId: "b", scheme: "jtw" }] },
			{ id: "s2", steps: [{ operationId: "c", origin: "cdn", scheme: "jwt" }] },
			{ id: "s3", origin: "gone", steps: [{ operationId: "d", scheme: "x" }] },
		]
		expect(documentProblems({ scenarios }, PRIMARY, ORIGINS)).toEqual([
			'scenarios.s1.steps[1].scheme "jtw" names no scheme in the document. Did you mean "jwt"? The document declares: apiKey, jwt',
			`scenarios.s2.steps[0].scheme "jwt" names no scheme in origin cdn's document. The document declares: cdnKey`,
		])
	})

	it("accepts a targetVersion scheme the document declares, and names one it does not, with did-you-mean", () => {
		expect(documentProblems(versionRead("jwt"), PRIMARY)).toEqual([])
		expect(documentProblems({ targetVersion: { from: "$.v", path: "/version" } }, PRIMARY)).toEqual([])
		expect(documentProblems({ targetVersion: "nope" }, PRIMARY)).toEqual([])
		expect(documentProblems(versionRead("jtw"), PRIMARY)).toEqual([
			'targetVersion.scheme "jtw" names no scheme in the document. Did you mean "jwt"? The document declares: apiKey, jwt',
		])
		expect(documentProblems(versionRead("zzzzzz"), PRIMARY)).toEqual([
			'targetVersion.scheme "zzzzzz" names no scheme in the document. The document declares: apiKey, jwt',
		])
	})

	it("reads nothing but a list of scenarios with steps", () => {
		expect(documentProblems({ scenarios: "nope" }, PRIMARY)).toEqual([])
		expect(documentProblems({ scenarios: [null, { id: "s", steps: "x" }] }, PRIMARY)).toEqual([])
	})
})
