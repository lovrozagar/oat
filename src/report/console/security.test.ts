import { describe, expect, it } from "vitest"
import { anyrow, everyScheme } from "../../spec/security/__fixtures__/documents.ts"
import { credentials, legacy, model } from "./__fixtures__/security.ts"
import { securityFacts, securityJson } from "./security.ts"

/*
 * Which principal sends each operation's requirement, decided by the run's own `satisfy` over the
 * recipes the run reads, and what doctor and plan put in their JSON.
 */

describe("securityFacts", () => {
	it("sorts groups by count, most first, then by requirement", () => {
		const facts = securityFacts(model(legacy), credentials({ jwt: { static: "t" }, legacy: { static: "l" } }))
		expect(facts.groups.map((group) => [group.requirement, group.operations])).toEqual([
			["legacy", 2],
			["jwt", 1],
		])
	})

	it("names alpha's reason when only beta satisfies", () => {
		const facts = securityFacts(
			model(anyrow),
			credentials({ apiKey: { static: "k" } }, { alpha: {}, beta: { security: { jwt: { static: "t" } } } }),
		)
		expect(facts.groups.map((group) => group.satisfier)).toEqual([
			undefined,
			"beta (alpha: no credential for jwt)",
			"beta via jwt (alpha: no credential for jwt; no credential for apiKey holding rows:read)",
		])
	})

	it("renders AND, OR, scopes and anonymous", () => {
		const facts = securityFacts(model(everyScheme))
		expect(facts.groups.map((group) => group.requirement).toSorted()).toEqual([
			"basic | anonymous",
			"missing",
			"oauth[read,write] + mtls",
		])
	})

	it("says no principal satisfies anything but an anonymous call when the config names none", () => {
		const facts = securityFacts(model(everyScheme), credentials({}, {}))
		expect(facts.operations.map((op) => op.unsatisfied)).toEqual([
			undefined,
			"the config names no principal",
			"the config names no principal",
		])
		expect(facts.groups.find((group) => group.requirement === "missing")?.satisfier).toBe(
			"none — the config names no principal",
		)
	})
})

describe("securityJson", () => {
	it("json carries satisfiedBy and unsatisfied", () => {
		const json = securityJson(securityFacts(model(legacy), credentials({ jwt: { static: "t" } })))
		expect(Object.keys(json)).toEqual(["schemes", "operations", "noRecipe", "unsupported", "undeclared"])
		expect(json.operations).toEqual([
			{
				alternatives: [[{ scheme: "jwt", scopes: [] }]],
				operationId: "a.get",
				satisfiedBy: { alternative: 0, principal: "alpha" },
				source: "root",
			},
			{
				alternatives: [[{ scheme: "legacy", scopes: [] }]],
				operationId: "b.get",
				source: "operation",
				unsatisfied: "no credential for legacy",
			},
			{
				alternatives: [[{ scheme: "legacy", scopes: [] }]],
				operationId: "c.get",
				source: "operation",
				unsatisfied: "no credential for legacy",
			},
		])
		expect(json.noRecipe).toEqual([{ name: "legacy", operations: 2 }])
		expect(json.schemes[1]).toEqual({
			deprecated: false,
			extraPlacements: 0,
			kind: "apiKey",
			name: "legacy",
			placement: { in: "header", name: "X-Legacy", template: "{credential}" },
			recipe: null,
		})
	})
})

describe("securityJson beside alpha, and without a config", () => {
	it("names alpha's reason beside another principal's, and leaves out what a config would say", () => {
		const beta = securityJson(
			securityFacts(model(anyrow), credentials({}, { alpha: {}, beta: { security: { jwt: { static: "t" } } } })),
		)
		expect(beta.operations[1]).toMatchObject({
			alphaUnsatisfied: "no credential for jwt",
			satisfiedBy: { alternative: 0, principal: "beta" },
		})
		const bare = securityJson(securityFacts(model(everyScheme)))
		expect(Object.keys(bare)).toEqual(["schemes", "operations", "unsupported", "undeclared"])
		expect(bare.operations.every((op) => !("satisfiedBy" in op) && !("unsatisfied" in op))).toBe(true)
		expect(bare.schemes.find((scheme) => scheme.name === "bearer")).toMatchObject({
			bearerFormat: "JWT",
			deprecated: true,
			recipe: null,
		})
		expect(bare.schemes.find((scheme) => scheme.name === "mtls")).toEqual({
			deprecated: false,
			extraPlacements: 0,
			kind: "unsupported",
			name: "mtls",
			placement: null,
			recipe: null,
			why: "mutualTLS is a TLS client certificate, not a request credential",
		})
		expect(bare.unsupported[2]).toEqual({
			name: "mtls",
			operations: 1,
			why: "mutualTLS is a TLS client certificate, not a request credential",
		})
		expect(bare.undeclared).toEqual([{ name: "missing", operations: 1 }])
	})
})
