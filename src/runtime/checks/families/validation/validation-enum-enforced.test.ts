import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { enumValidated } from "./validation-enum-enforced.ts"
import { GATED, cited, itemsDocument, stage } from "./__fixtures__/items.ts"

const schema = {
	properties: { name: { type: "string" }, status: { enum: ["open", "closed"], type: "string" } },
	required: ["name"],
	type: "object",
}
const gated = {
	"x-feature-gate": "pro",
	responses: { "201": { description: "made" }, "403": { description: "gated" } },
}

async function probe(answer: Answer, create: Record<string, unknown> = {}) {
	const staged = stage(itemsDocument(schema, create), answer)
	const plan = enumValidated.plan(staged.ctx)
	if (!plan.ok) throw new Error("the enum plan did not apply")
	return { ...staged, outcome: await enumValidated.run(staged.ctx, plan.value) }
}

describe("validation.enum-enforced plan", () => {
	it("does not apply without a create, or to a create body with no enum", () => {
		expect(enumValidated.plan(stage(itemsDocument(schema), { status: 201 }, { createOp: undefined }).ctx).ok).toBe(
			false,
		)
		const plain = { properties: { name: { type: "string" }, tags: { enum: [] } }, type: "object" }
		expect(enumValidated.plan(stage(itemsDocument(plain), { status: 201 }).ctx)).toEqual({
			needs: "a request field that declares an enum",
			ok: false,
		})
	})
})

describe("validation.enum-enforced run", () => {
	it("asserts when the backend refuses a value outside the enum, which it was sent", async () => {
		const { findings, outcome, sent } = await probe({ status: 422 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /items"])
		expect(sent[0]?.options.body).toMatchObject({ name: expect.any(String), status: "oat-not-in-enum" })
	})

	it("reports a backend bug when the value outside the enum is accepted", async () => {
		const { findings, outcome } = await probe({ status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a value outside the declared enum was accepted")
		expect(finding?.detail).toContain(
			`"status" declares ["open", "closed"] but the backend accepted "oat-not-in-enum" with 201`,
		)
		expect(cited(finding?.evidence ?? [])).toEqual(["POST /items 201"])
	})

	it("reports a server error as a backend bug, and an unrelated refusal as unresolved", async () => {
		expect((await probe({ status: 500 })).outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const forbidden = await probe({ status: 401 })
		expect(forbidden.outcome.kind).toBe("unresolved")
		expect(forbidden.findings.inconclusive.map((i) => i.check)).toEqual(["validation.enum-enforced"])
	})

	it("stands down on a documented feature-gate refusal", async () => {
		const { findings, outcome } = await probe(GATED, gated)
		expect(outcome).toEqual({ kind: "stood-down", reason: "a documented feature gate refused the request" })
		expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP"])
	})

	it("cannot conclude when no value outside the field's enum can be made", async () => {
		const { ctx, findings, sent } = stage(itemsDocument(schema), { status: 201 })
		const createOp = ctx.createOp
		if (createOp === undefined) throw new Error("the document has a create")
		const outcome = await enumValidated.run(ctx, { createOp, schema, target: { name: "status", schema: {} } })
		expect(outcome).toEqual({ kind: "unresolved", reason: "no enum declared" })
		expect(findings.inconclusive).toHaveLength(1)
		expect(sent).toEqual([])
	})
})
