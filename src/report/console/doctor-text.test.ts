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
	it("draws how many entities a run can follow and list", async () => {
		const facts = doctorFacts((await referenceModel()).model)
		/* The reference reads its API keys back (apiKey.get), so api-key is a trackable entity of its own. */
		expect(summaryLines(facts)).toEqual([
			"",
			`  trackable  ${"█".repeat(24)}  7/7 entities have an identity and a read`,
			`  listable   ${"█".repeat(14)}${"░".repeat(10)}  4/7 entities have a list, so query checks can run`,
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
			"    x-rate-limit     would enable spec.declared-rate-limit-is-honoured",
			"",
		])
		const empty = modelOf(documentOf({})).model
		expect(tagLines(empty, doctorFacts(empty))).not.toContain("  running, but on inferred information")
	})
})

describe("entityLines", () => {
	it("says why an entity cannot be followed, which have no list, and the roots a run needs", async () => {
		const edges = modelOf(EDGES).model
		const lines = entityLines(edges, doctorFacts(edges))
		expect(lines).toContain("  not trackable")
		expect(lines).toContain(
			`    ${"c".padEnd(20)} no identity property — instances cannot be tracked across projections`,
		)
		expect(lines).toContain(`    ${"d".padEnd(20)} no read surface — mutations cannot be verified`)
		expect(lines).toContain("  no list — query, pagination and count checks will not run")
		expect(lines).toContain(`    ${"u".padEnd(20)} GET /u/{id}`)
		const { model } = await referenceModel()
		const reference = entityLines(model, doctorFacts(model))
		expect(reference).toContain(`    ${"profile".padEnd(20)} profile.get`)
		expect(reference).toContain("  roots required in config (no create operation in this document)")
		expect(reference).not.toContain("  not trackable")
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
			"  config.entities names that do not match the document (ignored)",
			"    ghost",
			"",
		])
		const gated = modelOf(documentOf({ "/a": { get: listOp("a", "a.list", { "x-feature-gate": "beta" }) } })).model
		expect(declarationLines(doctorFacts(gated))).toEqual([
			"  feature gates — a matching 403 is a coverage gap, not a fail",
			`    ${"a.list".padEnd(28)} x-feature-gate: beta`,
			"",
		])
	})
})
