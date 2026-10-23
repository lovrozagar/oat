import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { contextFor, modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { widgetDoc } from "../write/__fixtures__/widget-api.ts"
import { problemJsonShape } from "./schema-problem-json-shape.ts"

const PROBLEM = "application/problem+json"

/** One request the transcript already holds: the operation it reached, and how it was answered. */
interface Sent {
	operationId?: string
	answer: Answer
	probe?: true
}

/* A context whose transcript holds `sent`, in order, and the operations the check said it judged. */
async function staged(sent: Sent[]) {
	const answers = sent.map((entry) => entry.answer)
	const { ctx, findings } = contextFor(modelOf(widgetDoc()), "listWidgets", {
		respond: () => answers.shift(),
	})
	for (const entry of sent) {
		await ctx.client.request("PATCH", "/widgets/w1", {
			as: { principal: "alpha" },
			...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
			...(entry.probe === undefined ? {} : { probe: true }),
		})
	}
	const judged: string[] = []
	ctx.judged = (ids) => judged.push(...ids)
	return { ctx, findings, judged }
}

const problem = (status: number, body: unknown, type = PROBLEM): Answer => ({
	body,
	headers: { "content-type": type },
	status,
})

const WELL_FORMED = {
	detail: "If-Match names a version the record no longer has",
	instance: "/widgets/w1",
	status: 412,
	title: "Precondition Failed",
	type: "about:blank",
}

describe("schema.problem-json-shape", () => {
	it("passes a problem detail shaped as RFC 9457 defines it, judging its operation", async () => {
		const { ctx, findings, judged } = await staged([
			{ answer: problem(412, WELL_FORMED, `${PROBLEM}; charset=utf-8`), operationId: "updateWidget" },
			{ answer: problem(404, { title: "Not Found", type: "/problems/missing" }), operationId: "getWidget" },
		])
		expect(await runCheck(problemJsonShape, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual(["updateWidget", "getWidget"])
	})

	it("judges nothing when no answer is a problem detail, nor one it cannot place on this entity", async () => {
		const { ctx, judged } = await staged([
			{ answer: problem(412, { status: 400 }, "application/json"), operationId: "updateWidget" },
			{ answer: problem(412, { status: 400 }, "application/problem+jsonl"), operationId: "updateWidget" },
			{ answer: problem(412, { status: 400 }) },
			{ answer: problem(412, { status: 400 }), operationId: "elsewhere" },
			{ answer: { status: 200 }, operationId: "updateWidget" },
			{ answer: problem(412, { status: 400 }), operationId: "deleteWidget" },
		])
		/* An operation this run does not grade is not judged. */
		ctx.inScope = (op) => op.operationId !== "deleteWidget"
		expect(await runCheck(problemJsonShape, ctx)).toEqual({
			kind: "stood-down",
			reason: "an answer this entity drew served as application/problem+json",
		})
		expect(judged).toEqual([])
	})

	it("reports a status member that disagrees with the HTTP status, even on a probe", async () => {
		const { ctx, findings } = await staged([
			{ answer: problem(412, { ...WELL_FORMED, status: 400 }), operationId: "updateWidget", probe: true },
		])
		expect(await runCheck(problemJsonShape, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a problem detail is not shaped as RFC 9457 defines it")
		expect(finding?.detail).toContain('updateWidget answered 412 with "status" 400, not the HTTP status 412')
		expect(finding?.evidence).toHaveLength(1)
	})
})

describe("schema.problem-json-shape findings", () => {
	it("names every malformed member, and a body that is no object at all", async () => {
		const { ctx, findings } = await staged([
			{
				answer: problem(409, { detail: 1, instance: false, status: "409", title: ["t"], type: "not a uri" }),
				operationId: "updateWidget",
			},
			{ answer: problem(400, ["a", "list"]), operationId: "createWidget" },
			{ answer: problem(400, null), operationId: "createWidget" },
			{ answer: problem(400, { type: 7 }), operationId: "createWidget" },
		])
		expect(await runCheck(problemJsonShape, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.detail).toContain(
			'updateWidget answered 409 with "type" "not a uri", not a URI reference, "title" ["t"], not a string, ' +
				'"detail" 1, not a string, "instance" false, not a string, "status" "409", not the HTTP status 409',
		)
		expect(finding?.detail).toContain("createWidget answered 400 with a body that is not a JSON object")
		expect(finding?.detail).toContain('createWidget answered 400 with "type" 7, not a URI reference')
		expect(finding?.operations).toEqual(["updateWidget", "createWidget"])
	})

	it("cites at most six answers", async () => {
		const sent = Array.from({ length: 8 }, () => ({ answer: problem(412, { status: 1 }), operationId: "updateWidget" }))
		const { ctx, findings } = await staged(sent)
		await runCheck(problemJsonShape, ctx)
		expect(findings.findings[0]?.evidence).toHaveLength(6)
	})

	it("grades every operation of the entity and always applies", () => {
		const model = modelOf(widgetDoc())
		const entity = model.entities.get("widget")
		if (entity === undefined) throw new Error("expected the widget entity")
		expect(problemJsonShape.subjects(entity, model).toSorted()).toEqual([
			"createWidget",
			"deleteWidget",
			"getWidget",
			"listWidgets",
			"updateWidget",
		])
		expect(problemJsonShape.judgesTranscript).toBe(true)
	})
})
