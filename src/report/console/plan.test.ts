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
import { plan } from "./plan.ts"

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
		expect(Object.keys(json)).toEqual(["entities", "grammars", "operations", "roots", "scope", "unique"])
		expect(json.entities.every((entity: { estimatedRequests: number }) => entity.estimatedRequests > 0)).toBe(true)
		expect(json.unique).toEqual([{ entity: "table", unique: [["name"]] }])
		const plain = JSON.parse(plan((await referenceModel()).model, true))
		expect(Object.keys(plain)).toEqual(["entities", "operations", "roots", "unique"])
	})
})

describe("plan as text", () => {
	it("tables each entity with its lifecycle, identity, cost and read surface, then what a run needs", async () => {
		const { model } = await referenceModel({ dialect: "template" })
		const lines = plan(model, false).split("\n")
		expect(lines[1]).toBe(`  ${model.operations.length} operations · 6 entities`)
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
