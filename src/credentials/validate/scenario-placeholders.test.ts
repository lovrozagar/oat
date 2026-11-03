import { describe, expect, it } from "vitest"
import { scenarioPlaceholderProblems } from "./scenario-placeholders.ts"

/* One scenario with `steps`, sent as alpha unless it names another, under the given principals and security. */
function problems(steps: unknown[], extra: Record<string, unknown> = {}): string[] {
	return scenarioPlaceholderProblems({
		principals: { alpha: { scope: { project_id: "p1" } }, beta: { scope: { team_id: "t1" } } },
		scenarios: [{ covers: [], id: "flow", steps, ...extra }],
		security: {
			jwt: { login: { claims: { "scope.organization_id": "orgs.0.oid", tenant: "sub" }, steps: [] } },
			apiKey: { login: { claims: { "scope.key_owner": "$.owner" }, steps: [] } },
		},
	})
}

const savesWith = (saveAs: Record<string, string>): string[] => problems([{ operationId: "a.get", saveAs }])

const refused = (name: string, step = 1): string[] => [
	`scenarios.flow.steps[${step}] reads {${name}}, which no earlier step, the principal's scope or a login claim provides`,
]

describe("scenarioPlaceholderProblems: what fills a placeholder", () => {
	it("passes a name an earlier step saved, claimed, waited for or asked a person for", () => {
		const steps = [
			{ operationId: "a.create", saveAs: { saved: "$.id" } },
			{ operationId: "a.login", saveClaimsFrom: { bind: { claimed: "orgs.0.oid" }, token: "$.access_token" } },
			{ outOfBand: { address: "{saved}", as: "mailed", kind: "otp" } },
			{ as: "consented", external: "consent", input: { code: "{mailed}" } },
			{ body: { a: "{saved}", b: "{claimed}", c: "{mailed}", d: "{consented}" }, operationId: "a.use" },
		]
		expect(problems(steps)).toEqual([])
	})

	it("passes a name a bind gives the same step, in order", () => {
		expect(problems([{ bind: { a: "x", b: "{a}" }, operationId: "a.get", query: { q: "{b}" } }])).toEqual([])
		expect(problems([{ bind: { a: "{a}" }, operationId: "a.get" }])).toEqual(refused("a", 0))
	})

	it("lets a saveAs address read a name an earlier entry of the same saveAs bound, and nothing later", () => {
		expect(savesWith({ id: "$.id", row: "$.rows[?(@.id=='{id}')]" })).toEqual([])
		expect(savesWith({ row: "$.rows[?(@.id=='{id}')]", id: "$.id" })).toEqual(refused("id", 0))
	})

	it("does not count a claim that binds identity rather than scope", () => {
		expect(problems([{ operationId: "a.get", query: { t: "{tenant}" } }])).toEqual(refused("tenant", 0))
	})

	it("leaves {principal.<key>} to the principal's identity", () => {
		expect(problems([{ body: { email: "{principal.email}" }, operationId: "a.get" }])).toEqual([])
	})

	it("does not let a step's own save fill its own asserts, read before the answer is saved", () => {
		const steps = [{ assert: { equals: "{id}", from: "$.id" }, operationId: "a.create", saveAs: { id: "$.id" } }]
		expect(problems(steps)).toEqual(refused("id", 0))
	})
})

describe("scenarioPlaceholderProblems: the principal's scope", () => {
	it("passes the scenario principal's config scope and any scheme's scope.<param> login claim", () => {
		const steps = [{ bind: { p: "{project_id}", o: "{organization_id}", k: "{key_owner}" }, operationId: "a.get" }]
		expect(problems(steps)).toEqual([])
		expect(problems([{ operationId: "a.get", query: { t: "{team_id}" } }])).toEqual(refused("team_id", 0))
		expect(problems([{ operationId: "a.get", query: { t: "{team_id}" } }], { principal: "beta" })).toEqual([])
	})

	it("passes a scope.<param> key written on the principal entry itself", () => {
		const config = {
			principals: { alpha: { "scope.workspace_id": "w1" } },
			scenarios: [{ covers: [], id: "flow", steps: [{ operationId: "a.get", query: { w: "{workspace_id}" } }] }],
		}
		expect(scenarioPlaceholderProblems(config)).toEqual([])
	})

	it("passes a scope.<param> claim the principal's own recipe override binds", () => {
		const own = { security: { jwt: { login: { claims: { "scope.orgId": "$.org" } } } } }
		const config = {
			principals: { alpha: own, beta: {} },
			scenarios: [
				{ covers: [], id: "flow", steps: [{ operationId: "a.get", query: { o: "{orgId}" } }] },
				{ covers: [], id: "other", principal: "beta", steps: [{ operationId: "a.get", query: { o: "{orgId}" } }] },
			],
		}
		expect(scenarioPlaceholderProblems(config)).toEqual([
			"scenarios.other.steps[0] reads {orgId}, which no earlier step, the principal's scope or a login claim provides",
		])
	})
})

describe("scenarioPlaceholderProblems: where a read is found", () => {
	it.each([
		["a raw path", { method: "GET", path: "/v1/{x}" }],
		["a header", { headers: { cookie: "s={x}" }, operationId: "a.get" }],
		["a query", { operationId: "a.get", query: { q: "{x}" } }],
		["a body, deep", { body: { a: [{ b: "{x}" }] }, operationId: "a.get" }],
		["an assert's from", { assert: { from: "$.events[?(@.id=='{x}')]", omits: "a" }, operationId: "a.get" }],
		[
			"an assert's expected text",
			{ assert: [{ from: "$.a" }, { contains: "{x}", from: "$.b" }], operationId: "a.get" },
		],
		["a saveAs address", { operationId: "a.get", saveAs: { y: "$.items[?(@.id=='{x}')]" } }],
		["an out-of-band address", { outOfBand: { address: "{x}", as: "y", kind: "otp" } }],
		["an external's input", { as: "y", external: "consent", input: { code: "{x}" } }],
	])("refuses {x} in %s", (_where, step) => {
		expect(problems([{ operationId: "a.first" }, step])).toEqual(refused("x"))
	})

	it("names only the first unfilled read of a scenario", () => {
		expect(problems([{ operationId: "a.get", query: { a: "{one}", b: "{two}" } }, { path: "{three}" }])).toEqual(
			refused("one", 0),
		)
	})
})

describe("scenarioPlaceholderProblems: a config it cannot read", () => {
	it("says nothing of shapes the config rules report", () => {
		expect(scenarioPlaceholderProblems({})).toEqual([])
		expect(scenarioPlaceholderProblems({ scenarios: "x" })).toEqual([])
		expect(scenarioPlaceholderProblems({ scenarios: ["x", { id: "a", steps: "x" }] })).toEqual([])
		expect(scenarioPlaceholderProblems({ scenarios: [{ id: "a", steps: ["x", { operationId: "a.b" }] }] })).toEqual([])
		const odd = {
			principals: { alpha: "x" },
			scenarios: [{ id: "a", steps: [] }],
			security: { jwt: "x", k: { login: "x" } },
		}
		expect(scenarioPlaceholderProblems(odd)).toEqual([])
	})

	it("leaves a scenario whose principal is not configured to the principals check", () => {
		const config = {
			principals: { alpha: {} },
			scenarios: [{ id: "flow", principal: "gamma", steps: [{ operationId: "a.get", query: { p: "{nope}" } }] }],
		}
		expect(scenarioPlaceholderProblems(config)).toEqual([])
	})

	it("starts from an empty scope when no principal is configured", () => {
		const config = { scenarios: [{ id: "flow", steps: [{ operationId: "a.get", query: { p: "{project_id}" } }] }] }
		expect(scenarioPlaceholderProblems(config)).toEqual(refused("project_id", 0))
	})
})

/* `{name}` read by a scenario that names no principal, under alpha and beta with beta the writer. */
const readAsWriter = (name: string): string[] =>
	scenarioPlaceholderProblems({
		principals: { alpha: { scope: { project_id: "p1" } }, beta: { scope: { team_id: "t1" } } },
		scenarios: [{ covers: [], id: "flow", steps: [{ operationId: "a.get", query: { q: `{${name}}` } }] }],
		writer: "beta",
	})

describe("scenarioPlaceholderProblems: a scenario that names no principal", () => {
	it("starts from the configured writer's scope, not the first principal's", () => {
		expect(readAsWriter("team_id")).toEqual([])
		expect(readAsWriter("project_id")).toEqual(refused("project_id", 0))
	})

	it("starts from the first principal's scope when no writer is configured", () => {
		expect(problems([{ operationId: "a.get", query: { q: "{project_id}" } }])).toEqual([])
	})
})
