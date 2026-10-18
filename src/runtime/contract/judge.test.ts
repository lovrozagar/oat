import { describe, expect, it } from "vitest"
import type { OperationObject } from "../../spec/types.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { doc, json, stage } from "./__fixtures__/stage.ts"
import { judge } from "./judge.ts"

const thing = { properties: { id: { type: "string" } }, required: ["id"], type: "object" }

/** A stage over one `GET /things` documented with `responses`, and its operation. */
function things(responses: Record<string, unknown>) {
	const { input, model } = stage(doc({ "/things": { get: { operationId: "things.get", responses } } }), () => undefined)
	const op = model.byOperationId.get("things.get")
	if (op === undefined) throw new Error("no things.get")
	return { input, op, raw: model.rawOperations.get("things.get") as OperationObject }
}

describe("judge", () => {
	it("fails a server error, naming a retry-after", () => {
		const { input, op, raw } = things({ "200": { description: "ok", ...json(thing) } })
		judge(input, op, raw, exchange("GET", "/things", { body: "boom", headers: { "retry-after": "3" }, status: 503 }))
		expect(input.findings.findings[0]).toMatchObject({ check: "response.contract-call", verdict: "BACKEND_BUG" })
		expect(input.findings.findings[0]?.detail).toBe("things.get returned 503: boom")
		expect(input.grades.ran.get("things.get")?.has("response.contract-call")).toBe(true)
	})

	it("leaves a refusal untested and an undocumented success unproven", () => {
		const refused = things({ "200": { description: "ok" } })
		judge(refused.input, refused.op, refused.raw, exchange("GET", "/things", { body: { error: "no" }, status: 422 }))
		expect([...(refused.input.grades.needs.get("things.get") ?? [])]).toEqual([
			'contract call returned 422 ({"error":"no"}); a scenario must set the scene',
		])
		const undocumented = things({ "200": { description: "ok" } })
		judge(undocumented.input, undocumented.op, undocumented.raw, exchange("GET", "/things", { status: 201 }))
		expect([...(undocumented.input.grades.needs.get("things.get") ?? [])]).toEqual([
			"contract call returned 201, which the document does not name",
		])
	})

	it("passes a documented success with no schema, or one whose body holds", () => {
		const bare = things({ "200": { description: "ok" } })
		const answered = exchange("GET", "/things", { body: "anything", status: 200 })
		judge(bare.input, bare.op, bare.raw, answered)
		expect(bare.input.grades.evidence.get("things.get")).toEqual({ call: answered.seq })
		const typed = things({ "200": { description: "ok", ...json(thing) } })
		judge(typed.input, typed.op, typed.raw, exchange("GET", "/things", { body: { id: "t1" }, status: 200 }))
		expect(typed.input.grades.evidence.has("things.get")).toBe(true)
		expect(typed.input.findings.findings).toEqual([])
	})

	it("fails a body that breaks the schema, and passes one the schema cannot check", () => {
		const typed = things({ "200": { description: "ok", ...json(thing) } })
		judge(typed.input, typed.op, typed.raw, exchange("GET", "/things", { body: {}, status: 200 }))
		expect(typed.input.findings.findings[0]).toMatchObject({ verdict: "SPEC_BUG" })
		expect(typed.input.findings.findings[0]?.detail).toMatch(/fails the declared schema: \(root\)/)
		const broken = things({ "200": { description: "ok", ...json({ type: "not-a-type" }) } })
		judge(broken.input, broken.op, broken.raw, exchange("GET", "/things", { body: {}, status: 200 }))
		expect(broken.input.findings.findings).toEqual([])
		expect(broken.input.grades.evidence.has("things.get")).toBe(true)
	})
})
