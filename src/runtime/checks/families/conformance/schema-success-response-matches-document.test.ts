import { describe, expect, it } from "vitest"
import { type Answer, contextFor } from "../../__fixtures__/harness.ts"
import { successSchemaHonoured } from "./schema-success-response-matches-document.ts"
import { type ItemsOptions, UNCOMPILABLE, itemOperations, modelOfItems } from "./__fixtures__/items.ts"

/** A context whose run already created an item, answered with `created`; then the check's outcome. */
async function judge(created: Answer | null, options: ItemsOptions = {}) {
	const model = modelOfItems(options)
	const staged = contextFor(model, "item.list", { respond: () => created ?? undefined, fields: itemOperations(model) })
	if (created !== null) await staged.ctx.client.request("POST", "/items", { operationId: "item.create" })
	const plan = successSchemaHonoured.plan(staged.ctx)
	if (!plan.ok) throw new Error("the success-schema plan did not apply")
	return { ...staged, outcome: await successSchemaHonoured.run(staged.ctx, plan.value) }
}

const verdicts = (findings: { findings: { verdict: string; summary: string }[] }) =>
	findings.findings.map((f) => [f.verdict, f.summary])

describe("schema.success-response-matches-document plan", () => {
	it("needs a create, a validator, and the create in the document", () => {
		const model = modelOfItems()
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined, fields: itemOperations(model) })
		expect(successSchemaHonoured.plan(ctx).ok).toBe(true)
		expect(successSchemaHonoured.plan({ ...ctx, createOp: undefined })).toEqual({ needs: undefined, ok: false })
		expect(successSchemaHonoured.plan({ ...ctx, validator: undefined }).ok).toBe(false)
		model.rawOperations.delete("item.create")
		expect(successSchemaHonoured.plan(ctx).ok).toBe(false)
	})

	it("runs after the create's status is judged", () => {
		expect(successSchemaHonoured.dependsOn).toEqual(["create.status-matches-document"])
	})
})

describe("schema.success-response-matches-document run", () => {
	it("asserts when the created body fits the schema documented for its status", async () => {
		const { findings, outcome } = await judge({ body: { id: "1", name: "a" }, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports a body carrying an undeclared field as a spec bug", async () => {
		const { findings, outcome } = await judge({ body: { extra: true, id: "1", name: "a" }, status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(verdicts(findings)).toEqual([["SPEC_BUG", "success response does not match its documented schema"]])
		expect(findings.findings[0]?.detail).toContain(
			"item.create returned 201 with a body that fails the declared schema",
		)
		expect(findings.findings[0]?.detail).toContain("must NOT have additional properties")
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([201])
	})

	it("cannot conclude without a successful create to read", async () => {
		const missing = await judge(null)
		expect(missing.outcome).toEqual({ kind: "unresolved", reason: "no successful create was observed" })
		expect((await judge({ status: 500 })).outcome.kind).toBe("unresolved")
	})

	it("cannot conclude when the create's status has no documented schema", async () => {
		const { findings, outcome } = await judge({ body: { id: "1", name: "a" }, status: 200 })
		expect(outcome.kind).toBe("unresolved")
		expect(findings.inconclusive[0]?.reason).toContain("create returned 200, which the document declares no schema for")
	})

	it("stands down on an event stream", async () => {
		const streamed = { body: "data: {}", headers: { "content-type": "text/event-stream" }, status: 201 }
		expect((await judge(streamed)).outcome).toEqual({
			kind: "stood-down",
			reason: "the create answers with an event stream",
		})
	})

	it("reports a schema AJV cannot compile as a coverage gap", async () => {
		const { findings, outcome } = await judge({ body: "x", status: 201 }, { created: UNCOMPILABLE })
		expect(outcome.kind).toBe("stood-down")
		expect(verdicts(findings)).toEqual([["COVERAGE_GAP", "item.create 201 has a schema that cannot be compiled"]])
	})
})
