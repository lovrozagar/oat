import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { doctorFacts } from "./doctor-facts.ts"
import { block, declarationLines, entityLines, summaryLines, tagLines } from "./doctor-text.ts"

const idParam = [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
const body = { content: { "application/json": { schema: { type: "object" } } } }

/* An entity no one can read back, one with no identity, and one read only through what its update invalidates. */
const EDGES = documentOf({
	"/c": {
		post: {
			operationId: "c.create",
			requestBody: body,
			responses: { "201": { description: "made" } },
			"x-entity": { action: "create", name: "c" },
		},
	},
	"/d/{id}": {
		delete: {
			operationId: "d.delete",
			parameters: idParam,
			responses: { "204": { description: "gone" } },
			"x-entity": { action: "delete", identity: "id", name: "d" },
		},
	},
	"/u/{id}": {
		patch: {
			operationId: "u.update",
			parameters: idParam,
			requestBody: body,
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			"x-entity": { action: "update", identity: "id", name: "u" },
			"x-invalidate": ["GET /u/{id}"],
		},
	},
})

describe("block", () => {
	it("titles non-empty rows and closes them with a blank line", () => {
		expect(block("t", [])).toEqual([])
		expect(block("t", ["  a"])).toEqual(["t", "  a", ""])
	})
})

describe("summaryLines", () => {
	it("draws how many entities a run can test and list", async () => {
		const facts = doctorFacts((await referenceModel()).model)
		/* With no recipe minting API keys, api-key is an entity of its own, tested through its creates. */
		expect(summaryLines(facts)).toEqual([
			"",
			`  testable   ${"█".repeat(24)}  8/8 entities a run can seed and check`,
			`  listable   ${"█".repeat(12)}${"░".repeat(12)}  4/8 entities have a list, so query checks can run`,
			"",
		])
	})

	it("says what the config's allow list removed", () => {
		const facts = doctorFacts(modelOf(documentOf({})).model)
		expect(summaryLines(facts, { allowRemoved: [] })[1]).toBe("  allow      0 operations removed")
		expect(summaryLines(facts, { allowRemoved: ["a"] })[1]).toBe("  allow      1 operation removed: a")
		expect(summaryLines(facts, { allowRemoved: ["a", "b"] })[1]).toBe("  allow      2 operations removed: a, b")
		expect(summaryLines(facts)[2]).toBe(
			`  listable   ${"─".repeat(24)}  0/0 entities have a list — query checks will not run`,
		)
	})
})

describe("tagLines", () => {
	it("names the checks each missing tag would enable, and what runs on inference", async () => {
		const { model } = await referenceModel({ untagged: true })
		const lines = tagLines(model, doctorFacts(model))
		expect(lines[0]).toBe("  38 check(s) cannot run against this document")
		expect(lines).toContain(
			"    x-async          would enable async.reaches-terminal-state, async.receipt-identifies-the-job",
		)
		expect(lines).toContain("  running, but on inferred information")
		expect(lines.some((line) => line.startsWith("    x-query          the remaining query checks"))).toBe(true)
		expect(lines.some((line) => line.startsWith("    x-tenant         an inferred tenant"))).toBe(true)
	})

	it("is quieter for a document that declares its tags, and silent on inference with nothing to infer", async () => {
		const { model } = await referenceModel()
		const lines = tagLines(model, doctorFacts(model))
		expect(lines).toEqual([
			"  2 check(s) cannot run against this document",
			"    x-destructive    would enable auth.destructive-spares-the-caller",
			"    x-rate-limit     would enable spec.declared-rate-limit-is-honored",
			"",
		])
		const empty = modelOf(documentOf({})).model
		expect(tagLines(empty, doctorFacts(empty))).not.toContain("  running, but on inferred information")
	})
})

describe("entityLines", () => {
	it("says why a run cannot test an entity, which have no list, and the roots a run needs", async () => {
		const edges = modelOf(EDGES).model
		const lines = entityLines(doctorFacts(edges))
		expect(lines.slice(0, 5)).toEqual([
			"  not testable",
			`    ${"c".padEnd(20)} "c" has no list operation and no read operation and no records oat can identify after create`,
			`    ${"d".padEnd(20)} "d" has no list operation and no create operation`,
			`    ${"u".padEnd(20)} "u" has no list operation and no create operation`,
			"",
		])
		expect(lines).not.toContain("  no list — query, pagination and count checks will not run")
		const { model } = await referenceModel()
		const reference = entityLines(doctorFacts(model))
		expect(reference).toContain("  no list — query, pagination and count checks will not run")
		expect(reference).toContain(`    ${"api-key".padEnd(20)} apiKey.get`)
		expect(reference).toContain(`    ${"profile".padEnd(20)} profile.get`)
		/* The caller with an update and no read is read where its update says it changes. */
		const caller = modelOf(
			documentOf({
				"/me": {
					patch: {
						operationId: "me.update",
						requestBody: body,
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "update", identity: "self", name: "me" },
						"x-invalidate": ["GET /me"],
					},
				},
			}),
		).model
		expect(entityLines(doctorFacts(caller))).toContain(`    ${"me".padEnd(20)} GET /me`)
		expect(reference).toContain("  roots required in config (no create operation in this document)")
		expect(reference).toContain(
			"  ids no operation creates — their operations run once a flow or hooks.resolvePathValue yields one",
		)
		expect(reference).not.toContain("  not testable")
		const scoped = { alpha: { scope: { project_id: "proj_alpha" } } }
		const supplied = entityLines(doctorFacts(model, { credentials: { principals: scoped, security: {} } }))
		expect(supplied).not.toContain("  roots required in config (no create operation in this document)")
		expect(supplied).toContain(`    ${"project_id".padEnd(20)} principal scope`)
	})
})

describe("declarationLines", () => {
	it("lists gates, unique sets, invites and config entities the document lacks", async () => {
		const { model } = await referenceModel()
		const lines = declarationLines({ ...doctorFacts(model), unknownEntities: ["ghost"] })
		expect(lines).toEqual([
			"  unique constraints — a 409 on a duplicate of these columns is a pass",
			`    ${"table".padEnd(28)} x-unique: [name]`,
			"",
			"  invite — accept mode",
			`    ${"table".padEnd(28)} JSON token → invite.accept`,
			"",
			"  cache bypass oat sends on reads",
			"    default cache-control: no-cache      16 reads",
			"",
			"  config.entities names that do not match the document (ignored)",
			"    ghost",
			"",
		])
		const gated = modelOf(documentOf({ "/a": { get: listOp("a", "a.list", { "x-feature-gate": "beta" }) } })).model
		expect(declarationLines(doctorFacts(gated))).toEqual([
			"  feature gates — a matching 403 is a coverage gap, not a fail",
			`    ${"a.list".padEnd(28)} x-feature-gate: beta`,
			"",
			"  cache bypass oat sends on reads",
			"    default cache-control: no-cache      1 read",
			"",
		])
	})
})
