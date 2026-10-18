import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { maxLengthValidated } from "./validation-max-length-enforced.ts"
import { GATED, cited, itemsDocument, stage } from "./__fixtures__/items.ts"

const schema = {
	properties: { code: { maxLength: 8, type: "string" }, name: { type: "string" } },
	required: ["name"],
	type: "object",
}
const gated = {
	"x-feature-gate": "pro",
	responses: { "201": { description: "made" }, "403": { description: "gated" } },
}

async function probe(answer: Answer, create: Record<string, unknown> = {}) {
	const staged = stage(itemsDocument(schema, create), answer)
	const plan = maxLengthValidated.plan(staged.ctx)
	if (!plan.ok) throw new Error("the maxLength plan did not apply")
	return { ...staged, outcome: await maxLengthValidated.run(staged.ctx, plan.value) }
}

describe("validation.max-length-enforced plan", () => {
	it("does not apply without a create, or when no field has a probeable maxLength", () => {
		expect(maxLengthValidated.plan(stage(itemsDocument(schema), { status: 201 }, { createOp: undefined }).ctx).ok).toBe(
			false,
		)
		const huge = { properties: { body: { maxLength: 4096, type: "string" } }, type: "object" }
		expect(maxLengthValidated.plan(stage(itemsDocument(huge), { status: 201 }).ctx)).toEqual({
			needs: "a request field that declares a maxLength",
			ok: false,
		})
	})
})

describe("validation.max-length-enforced run", () => {
	it("asserts when a value one character over the limit is refused", async () => {
		const { findings, outcome, sent } = await probe({ status: 400 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent[0]?.options.body).toMatchObject({ code: "xxxxxxxxx", name: expect.any(String) })
	})

	it("reports a backend bug when the over-long value is stored", async () => {
		const { findings, outcome } = await probe({ status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a string longer than the declared maxLength was accepted")
		expect(finding?.detail).toBe(
			'"code" declares maxLength 8 but a 9-character value was stored (201). The constraint exists in the document only.',
		)
		expect(cited(finding?.evidence ?? [])).toEqual(["POST /items 201"])
	})

	it("reports a server error, and leaves an unrelated refusal unresolved", async () => {
		expect((await probe({ status: 503 })).outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect((await probe({ status: 404 })).outcome.kind).toBe("unresolved")
	})

	it("stands down on a documented feature-gate refusal", async () => {
		const { findings, outcome } = await probe(GATED, gated)
		expect(outcome).toEqual({ kind: "stood-down", reason: "a documented feature gate refused the request" })
		expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP"])
	})

	it("stands down without a request when no over-long value can be made", async () => {
		const { ctx, sent } = stage(itemsDocument(schema), { status: 201 })
		const createOp = ctx.createOp
		if (createOp === undefined) throw new Error("the document has a create")
		const outcome = await maxLengthValidated.run(ctx, { createOp, schema, target: { name: "code", schema: {} } })
		expect(outcome).toEqual({ kind: "stood-down", reason: "no maxLength declared" })
		expect(sent).toEqual([])
	})
})
