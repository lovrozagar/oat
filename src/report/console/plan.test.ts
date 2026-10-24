import { describe, expect, it } from "vitest"
import { planScope } from "../../runtime/scope/plan.ts"
import { resolveTargetScope } from "../../runtime/scope/target.ts"
import { type ScopePlan } from "../../runtime/scope/types.ts"
import {
	documentOf,
	FILTER_TEMPLATE,
	listOp,
	modelOf,
	readOp,
	referenceModel,
	SORT_TEMPLATE,
} from "./__fixtures__/models.ts"
import { anyrow } from "../../spec/security/__fixtures__/documents.ts"
import { plan } from "./plan.ts"
import type { SecurityCredentials } from "./security.ts"

const scopePlan = (over: Partial<ScopePlan> = {}): ScopePlan => ({
	entities: [],
	excluded: [],
	mode: "targeted",
	origins: {},
	requested: { only: [], ops: ["x.get"] },
	support: [],
	targets: [],
	untestable: [],
	...over,
})

describe("plan as JSON", () => {
	it("carries entities with their cost, operations, roots, unique sets, and grammars and scope when there are any", async () => {
		const { model } = await referenceModel({ dialect: "template" })
		const json = JSON.parse(plan(model, true, { scope: scopePlan() }))
		expect(Object.keys(json)).toEqual([
			"entities",
			"grammars",
			"operations",
			"prefixRoots",
			"unmadeIds",
			"scope",
			"security",
			"unique",
		])
		expect(json.entities.every((entity: { estimatedRequests: number }) => entity.estimatedRequests > 0)).toBe(true)
		expect(json.unique).toEqual([{ entity: "table", unique: [["name"]] }])
		const plain = JSON.parse(plan((await referenceModel()).model, true))
		expect(Object.keys(plain)).toEqual(["entities", "operations", "prefixRoots", "unmadeIds", "security", "unique"])
	})
})

describe("plan as text", () => {
	it("tables each entity with its lifecycle, identity, cost and read surface, then what a run needs", async () => {
		const { model } = await referenceModel({ dialect: "template" })
		const lines = plan(model, false).split("\n")
		/* The reference reads its API keys back (apiKey.get), so api-key is a trackable entity of its own. */
		expect(lines[1]).toBe(`  ${model.operations.length} operations · 8 entities`)
		expect(lines.find((line) => line.startsWith("  notice "))).toMatch(
			/ ·LR·· {2}id +\d+ {2}2 route\(s\) \(inferred\)$/,
		)
		expect(lines.find((line) => line.startsWith("  table "))).toMatch(/ CLRUD {2}id +\d+ {2}2 route\(s\) \(declared\)$/)
		expect(lines).toContain("  roots — no create operation, must be supplied before a run:")
		expect(lines).toContain("    table                        x-unique: [name]")
		expect(lines).toContain("    table                        JSON token → invite.accept")
		expect(lines).toContain("  declared grammars — how oat writes this entity's filter and sort terms:")
		expect(lines.some((line) => line.startsWith("    table                        filter  template"))).toBe(true)
		expect(lines.some((line) => line.startsWith("    table                        sort    template"))).toBe(true)
		expect(lines.at(-1)).toBe("")
	})

	it("names feature gates", () => {
		const doc = documentOf({
			"/a": { get: listOp("a", "a.list", { "x-feature-gate": "beta" }) },
			"/b/{id}": { get: readOp("b", "b.get") },
		})
		const lines = plan(modelOf(doc).model, false).split("\n")
		expect(lines).toContain("  feature gates — a matching 403 is coverage, not a defect:")
		expect(lines).toContain(`    ${"a.list".padEnd(28)} x-feature-gate: beta`)
	})

	it("prints only the grammars an entity declares", () => {
		const doc = documentOf({
			"/a": { get: listOp("a", "a.list", { "x-query": { grammar: FILTER_TEMPLATE } }) },
			"/b": { get: listOp("b", "b.list") },
		})
		const { model } = modelOf(doc, { entities: { b: { query: { sortGrammar: SORT_TEMPLATE } } } })
		const rows = plan(model, false)
			.split("\n")
			.filter((line) => /^ {4}[ab] +(filter|sort) /.test(line))
			.map((line) => line.trim().split(/ +/).slice(0, 2).join(" "))
		expect(rows).toEqual(["a filter", "b sort"])
	})

	it("prints an empty document as an empty table", () => {
		expect(plan(modelOf(documentOf({})).model, false)).toBe(
			[
				"",
				"  0 operations · 0 entities",
				"",
				"  entity              CLRUD  ident        ~req  read surface",
				"  ─────────────────────────────────────────────────────────────────────",
				"",
				"  ~0 requests estimated for a full run, from typical per-check costs",
				"",
			].join("\n"),
		)
	})
})

describe("plan as text, for an entity nothing reads", () => {
	it("marks an entity no route reads", () => {
		const doc = documentOf({
			"/c": {
				post: {
					operationId: "c.create",
					requestBody: { content: { "application/json": { schema: { type: "object" } } } },
					responses: { "201": { description: "made" } },
					"x-entity": { action: "create", name: "c" },
				},
			},
		})
		expect(plan(modelOf(doc).model, false)).toMatch(/\n {2}c {19}C···· {2}— {10}\s*\d+ {2}— none\n/)
	})
})

describe("plan and the operations a recipe names", () => {
	it("keeps an entity whose operations a security recipe calls when its create answers an id, in text and JSON", async () => {
		const { model } = await referenceModel()
		const authCreates = Object.assign(new Set(["apiKey.create", "apiKey.revoke"]), {
			mints: new Set(["apiKey.create"]),
		})
		expect(plan(model, false, { authCreates }).split("\n")[1]).toBe(
			`  ${model.operations.length} operations · 8 entities`,
		)
		const json = JSON.parse(plan(model, true, { authCreates })) as { entities: Array<{ name: string }> }
		expect(json.entities.map((entity) => entity.name)).toContain("api-key")
		expect(json.entities).toHaveLength(8)
	})
})

describe("plan with a targeted scope", () => {
	it("lists targets, what cannot be tested, profile exclusions, origins, queued entities and support", () => {
		const text = plan(modelOf(documentOf({})).model, false, {
			scope: scopePlan({
				entities: ["row"],
				excluded: [{ operationId: "row.delete", reason: "x-destructive" }],
				origins: { billing: ["invoice.get", "invoice.list"] },
				requested: { only: ["row"], ops: ["row.get"] },
				support: ["row.create", "auth.token"],
				targets: [
					{ checks: ["a", "b"], entity: "row", operationId: "row.get" },
					{ checks: [], entity: null, operationId: "a-long-operation-id.get" },
				],
				untestable: [{ operationId: "row.export", reason: "no entity" }],
			}),
		})
		const width = "a-long-operation-id.get".length + 2
		expect(text.split("\n")).toEqual([
			"",
			"  scope: targeted (--ops row.get --only row)",
			"",
			"  targets",
			`    ${"row.get".padEnd(width)}entity ${"row".padEnd(14)}2 check(s)`,
			`    ${"a-long-operation-id.get".padEnd(width)}entity ${"—".padEnd(14)}0 check(s)`,
			"  untestable — a run reports these untested and exits 1",
			`    ${"row.export".padEnd(width)}no entity`,
			"  excluded by the profile",
			`    ${"row.delete".padEnd(width)}x-destructive`,
			"  origin billing: invoice.get, invoice.list",
			"  entities queued: row",
			"  support (called, never graded): row.create, auth.token",
			"",
		])
	})

	it("says when nothing is gradable, queued or supporting", async () => {
		const text = plan(modelOf(documentOf({})).model, false, { scope: scopePlan() })
		expect(text).toContain("    — none gradable")
		expect(text).toContain("  entities queued: none")
		expect(text).toContain("  support (called, never graded): none")
		const { model } = await referenceModel()
		const real = planScope(model, resolveTargetScope(model, { authCreates: new Set<string>(), ops: ["table.get"] }))
		expect(plan(model, false, { scope: real })).toContain("  scope: targeted (--ops table.get)")
	})
})

describe("plan and credentials", () => {
	const credentials: SecurityCredentials = {
		principals: { alpha: {} },
		security: {
			apiKey: { holds: ["rows:read"], static: "k" },
			jwt: { login: { from: "$.access_token", steps: [{ operationId: "auth.login" }] } },
		},
	}

	it("prints each operation's requirement and principal", () => {
		const lines = plan(modelOf(anyrow).model, false, { credentials }).split("\n")
		expect(lines.slice(lines.indexOf("  security — operation · requirement · principal"))).toEqual([
			"  security — operation · requirement · principal",
			"    auth.login               anonymous",
			"    me.get                   jwt                       alpha",
			"    row.list                 jwt | apiKey[rows:read]   alpha via jwt",
			"",
		])
	})

	it("gives a targeted row its requirement, and the JSON its security and unset variables", () => {
		const { model } = modelOf(anyrow)
		const scope = scopePlan({ targets: [{ checks: ["a"], entity: null, operationId: "row.list" }] })
		expect(plan(model, false, { credentials, scope })).toContain(
			"1 check(s)  jwt | apiKey[rows:read] (alpha via jwt)\n",
		)
		const json = JSON.parse(plan(model, true, { credentials, unsetEnv: ["OAT_JWT_TOKEN"] }))
		expect(json.unsetEnv).toEqual(["OAT_JWT_TOKEN"])
		expect(json.security.operations[2].satisfiedBy).toEqual({ alternative: 0, principal: "alpha" })
	})
})

describe("plan and the roots a config supplies", () => {
	it("lists a root the config supplies, and blocks on none a hook resolves", async () => {
		const { model } = await referenceModel()
		const credentials = { principals: { alpha: { scope: { project_id: "p1" } } }, security: {} }
		const scoped = plan(model, false, { credentials })
		expect(scoped).toContain(`    ${"project_id".padEnd(20)} principal scope`)
		expect(scoped).not.toContain("must be supplied before a run")
		const hooked = JSON.parse(plan(model, true, { hooks: { resolvePathValue: async () => null } }))
		expect(hooked.prefixRoots.required).toEqual([])
		expect(hooked.unmadeIds).toEqual([])
	})
})
