import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { asText, contentTypeEnforced, declaredMediaTypeOf } from "./validation-content-type-enforced.ts"
import { GATED, cited, itemsDocument, stage } from "./__fixtures__/items.ts"

const schema = { properties: { name: { type: "string" } }, required: ["name"], type: "object" }
const documented = { responses: { "201": { description: "made" }, "415": { description: "unsupported" } } }
const gated = {
	"x-feature-gate": "pro",
	responses: { ...documented.responses, "403": { description: "gated" } },
}

async function probe(answer: Answer, create: Record<string, unknown> = documented, mediaType?: string) {
	const staged = stage(itemsDocument(schema, create, mediaType), answer)
	const plan = contentTypeEnforced.plan(staged.ctx)
	if (!plan.ok) throw new Error("the content-type plan did not apply")
	return { ...staged, outcome: await contentTypeEnforced.run(staged.ctx, plan.value) }
}

describe("validation.content-type-enforced plan", () => {
	it("applies only to a create that documents 415 and takes a body", () => {
		expect(
			contentTypeEnforced.plan(stage(itemsDocument(schema, documented), { status: 201 }, { createOp: undefined }).ctx),
		).toEqual({ needs: undefined, ok: false })
		expect(contentTypeEnforced.plan(stage(itemsDocument(schema), { status: 201 }).ctx).ok).toBe(false)
		expect(contentTypeEnforced.plan(stage(itemsDocument(null, documented), { status: 201 }).ctx).ok).toBe(false)
		expect(contentTypeEnforced.plan(stage(itemsDocument(schema, documented), { status: 201 }).ctx).ok).toBe(true)
	})
})

describe("validation.content-type-enforced run", () => {
	it("sends the valid body as text/plain and asserts on a 415", async () => {
		const { findings, outcome, sent } = await probe({ status: 415 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent[0]?.options.contentType).toBe("text/plain")
		const body = sent[0]?.options.body
		expect(typeof body).toBe("string")
		expect(JSON.parse(body as string)).toMatchObject({ name: expect.any(String) })
	})

	it("sends a form body as its query string", async () => {
		const { sent } = await probe({ status: 415 }, documented, "application/x-www-form-urlencoded")
		expect(sent[0]?.options.body).toMatch(/^name=/)
	})

	it("reports a backend bug when the mislabeled body is processed, naming the declared media type", async () => {
		const { findings, outcome } = await probe({ status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a request labeled with an undeclared content type was processed")
		expect(finding?.detail).toContain(
			"declares application/json, but the same body sent as text/plain was processed (201)",
		)
		expect(cited(finding?.evidence ?? [])).toEqual(["POST /items 201"])
	})

	it("accepts only 415 as the refusal it tests: 422 is unresolved, 500 a backend bug", async () => {
		expect((await probe({ status: 422 })).outcome.kind).toBe("unresolved")
		expect((await probe({ status: 500 })).outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("stands down on a documented feature-gate refusal", async () => {
		const { findings, outcome } = await probe(GATED, gated)
		expect(outcome).toEqual({ kind: "stood-down", reason: "a documented feature gate refused the request" })
		expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP"])
	})
})

describe("declaredMediaTypeOf", () => {
	it("names the request media type, or says a declared one when there is none to name", () => {
		expect(declaredMediaTypeOf({ requestBody: { content: { "application/xml": {} } } } as never)).toBe(
			"application/xml",
		)
		expect(declaredMediaTypeOf({ responses: {} } as never)).toBe("a declared media type")
		expect(declaredMediaTypeOf(undefined)).toBe("a declared media type")
	})
})

describe("asText", () => {
	it("sends a form as its query string, text as itself, and anything else as JSON", () => {
		expect(asText(new URLSearchParams({ a: "1" }))).toBe("a=1")
		expect(asText("<item/>")).toBe("<item/>")
		expect(asText({ a: 1 })).toBe('{"a":1}')
	})
})
