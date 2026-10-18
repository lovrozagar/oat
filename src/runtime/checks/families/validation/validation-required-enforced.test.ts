import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { requiredValidated } from "./validation-required-enforced.ts"
import { GATED, cited, itemsDocument, stage } from "./__fixtures__/items.ts"

const schema = {
	properties: { name: { type: "string" }, note: { type: "string" }, title: { type: "string" } },
	required: ["title", "name"],
	type: "object",
}
const gated = {
	"x-feature-gate": "pro",
	responses: { "201": { description: "made" }, "403": { description: "gated" } },
}

async function probe(answer: Answer, create: Record<string, unknown> = {}) {
	const staged = stage(itemsDocument(schema, create), answer)
	const plan = requiredValidated.plan(staged.ctx)
	if (!plan.ok) throw new Error("the required plan did not apply")
	return { ...staged, outcome: await requiredValidated.run(staged.ctx, plan.value) }
}

describe("validation.required-enforced plan", () => {
	it("does not apply without a create, or to a body that requires nothing", () => {
		expect(requiredValidated.plan(stage(itemsDocument(schema), { status: 201 }, { createOp: undefined }).ctx).ok).toBe(
			false,
		)
		const needs = { needs: "a request body with a required field", ok: false }
		for (const required of [undefined, [], "title"]) {
			const open = { properties: { title: { type: "string" } }, required, type: "object" }
			expect(requiredValidated.plan(stage(itemsDocument(open), { status: 201 }).ctx)).toEqual(needs)
		}
	})
})

describe("validation.required-enforced run", () => {
	it("omits the first required field, keeps the rest, and asserts on a refusal", async () => {
		const { findings, outcome, sent } = await probe({ status: 422 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		const body = sent[0]?.options.body as Record<string, unknown>
		expect(Object.keys(body)).not.toContain("title")
		expect(body).toMatchObject({ name: expect.any(String) })
	})

	it("reports a backend bug when the create succeeds without the field", async () => {
		const { findings, outcome } = await probe({ status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("create succeeded without a required field")
		expect(finding?.detail).toContain(`"title" is listed in the schema's required array, but omitting it returned 201`)
		expect(cited(finding?.evidence ?? [])).toEqual(["POST /items 201"])
	})

	it("reports a server error, and leaves an unrelated refusal unresolved", async () => {
		expect((await probe({ status: 500 })).outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect((await probe({ status: 429 })).outcome.kind).toBe("unresolved")
	})

	it("stands down on a documented feature-gate refusal", async () => {
		const { findings, outcome } = await probe(GATED, gated)
		expect(outcome).toEqual({ kind: "stood-down", reason: "a documented feature gate refused the request" })
		expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP"])
	})
})
