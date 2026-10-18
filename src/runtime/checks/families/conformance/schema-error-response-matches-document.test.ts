import { describe, expect, it } from "vitest"
import type { Exchange } from "../../../exchange.ts"
import type { Answer } from "../../__fixtures__/harness.ts"
import { errorSchemaHonoured } from "./schema-error-response-matches-document.ts"
import {
	GATE_BODY,
	type ItemsOptions,
	ITEM,
	UNCOMPILABLE,
	json,
	modelOfItems,
	overTranscript,
	seen,
	type Transcript,
	unnamed,
} from "./__fixtures__/items.ts"

/** Plans and runs the check over `exchanges`, with the read's probe answered by `missing`. */
async function judge(exchanges: Exchange[], missing: Answer, transcript: Transcript = {}, options: ItemsOptions = {}) {
	const judged: string[][] = []
	const fields = { judged: (ids: readonly string[]) => judged.push([...ids]), ...transcript.fields }
	const staged = overTranscript(modelOfItems(options), exchanges, { ...transcript, fields, respond: () => missing })
	const plan = errorSchemaHonoured.plan(staged.ctx)
	if (!plan.ok) throw new Error("the error-schema plan did not apply")
	const outcome = await errorSchemaHonoured.run(staged.ctx, plan.value)
	return { ...staged, judged, outcome }
}

const summaries = (findings: { findings: { verdict: string; summary: string; operations?: string[] }[] }) =>
	findings.findings.map((f) => [f.verdict, f.summary, f.operations])

describe("schema.error-response-matches-document plan", () => {
	it("needs a read, a validator, and the read in the document", () => {
		const { ctx, model } = overTranscript(modelOfItems(), [])
		expect(errorSchemaHonoured.plan(ctx).ok).toBe(true)
		expect(errorSchemaHonoured.plan({ ...ctx, readOp: undefined })).toEqual({ needs: undefined, ok: false })
		expect(errorSchemaHonoured.plan({ ...ctx, validator: undefined }).ok).toBe(false)
		model.rawOperations.delete("item.read")
		expect(errorSchemaHonoured.plan(ctx).ok).toBe(false)
	})

	it("grades the read, the gated operations and those that declare unique columns", () => {
		const model = modelOfItems()
		const item = model.entities.get("item")
		if (item === undefined) throw new Error("the document has an item entity")
		expect(errorSchemaHonoured.subjects(item, model).toSorted()).toEqual(["item.create", "item.read", "item.update"])
	})
})

describe("schema.error-response-matches-document probe", () => {
	it("asks for an id no record holds and asserts on an error body that fits its schema", async () => {
		const { findings, judged, outcome, sent } = await judge([], { body: { error: "not found" }, status: 404 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => s.method)).toEqual(["GET"])
		expect(sent[0]?.path).toMatch(/^\/items\/oat-absent-/)
		expect(judged).toEqual([["item.read"]])
	})

	it("reports a 404 body that fails the documented schema as a spec bug on the read", async () => {
		const { findings, outcome } = await judge([], { body: { message: "nope" }, status: 404 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(summaries(findings)).toEqual([
			["SPEC_BUG", "404 error body does not match its documented schema", ["item.read"]],
		])
		expect(findings.findings[0]?.detail).toContain("item.read returned 404 with a body that fails the schema")
		expect(findings.findings[0]?.detail).toContain("must have required property 'error'")
	})

	it("reports a schema AJV cannot compile as a coverage gap", async () => {
		const { findings } = await judge([], { body: "x", status: 404 }, {}, { missing: UNCOMPILABLE })
		expect(summaries(findings)).toEqual([
			["COVERAGE_GAP", "item.read 404 has a schema that cannot be compiled", undefined],
		])
	})

	it("judges no body when the read succeeds or answers a status without a schema", async () => {
		expect((await judge([], { body: {}, status: 200 })).findings.findings).toEqual([])
		expect((await judge([], { body: {}, status: 500 })).findings.findings).toEqual([])
	})

	it("sends nothing when no identifier of the documented shape names no record", async () => {
		const { findings, judged, sent } = await judge([], { status: 404 }, {}, { id: { enum: ["a"], type: "string" } })
		expect(sent).toEqual([])
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["item.read"]])
	})
})

describe("schema.error-response-matches-document probe preconditions", () => {
	it("leaves the read alone when this run does not grade it", async () => {
		const { judged, sent } = await judge(
			[],
			{ status: 404 },
			{ fields: { inScope: (op) => op.operationId !== "item.read" } },
		)
		expect(sent).toEqual([])
		expect(judged).toEqual([[]])
	})

	it("stands down on an empty list with no create, and probes when the list held a record", async () => {
		const { ctx } = overTranscript(modelOfItems(), [], { fields: { createOp: undefined } })
		const plan = errorSchemaHonoured.plan(ctx)
		if (!plan.ok) throw new Error("the error-schema plan did not apply")
		expect(await errorSchemaHonoured.run(ctx, plan.value)).toEqual({
			kind: "stood-down",
			reason: "the list returned no id",
		})
		const listed = await judge([], { status: 404 }, { fields: { createOp: undefined, records: [{}] as never } })
		expect(listed.sent).toHaveLength(1)
	})
})

describe("schema.error-response-matches-document over the transcript", () => {
	const fine = { body: { error: "missing" }, status: 404 }

	it("judges the body of a documented feature-gate 403, read back from storage", async () => {
		const gate = seen("item.update", { status: 403 })
		const { findings, hydrated, judged } = await judge([gate], fine, {
			stored: new Map([[gate, { vars: GATE_BODY.vars }]]),
		})
		expect(hydrated).toEqual([gate])
		expect(summaries(findings)).toEqual([
			["SPEC_BUG", "403 error body does not match its documented schema", ["item.update"]],
		])
		expect(judged).toEqual([["item.read", "item.update"]])
	})

	it("judges a unique conflict's 409, and passes one whose body fits", async () => {
		const drifted = await judge([seen("item.create", { body: { code: 1 }, status: 409 })], fine)
		expect(summaries(drifted.findings)).toEqual([
			["SPEC_BUG", "409 error body does not match its documented schema", ["item.create"]],
		])
		const fits = await judge([seen("item.create", { body: { error: "taken" }, status: 409 })], fine)
		expect(fits.findings.findings).toEqual([])
		expect(fits.judged).toEqual([["item.read", "item.create"]])
	})

	it("reports a conflict schema AJV cannot compile as a gap on its operation", async () => {
		const { findings } = await judge(
			[seen("item.create", { body: "x", status: 409 })],
			fine,
			{},
			{ conflict: UNCOMPILABLE },
		)
		expect(summaries(findings)).toEqual([
			["COVERAGE_GAP", "item.create 409 has a schema that cannot be compiled", ["item.create"]],
		])
	})
})

describe("schema.error-response-matches-document transcript stand-asides", () => {
	const fine = { body: { error: "missing" }, status: 404 }

	it("passes over exchanges that are not an expected refusal on this entity's graded operations", async () => {
		const success = seen("item.create", { body: {}, status: 201 })
		const { findings, hydrated, judged } = await judge(
			[
				success,
				seen("item.read", { body: {}, status: 409 }),
				seen("item.read", { body: {}, status: 404 }),
				seen("item.create", { body: {}, status: 409 }, { superseded: true }),
				unnamed({ body: {}, status: 409 }),
				seen("nothing.here", { body: {}, status: 409 }),
				seen("other.list", { body: GATE_BODY, status: 403 }),
				seen("item.update", { body: GATE_BODY, status: 403 }),
			],
			fine,
			{ fields: { inScope: (op) => op.operationId !== "item.update" } },
		)
		expect(findings.findings).toEqual([])
		expect(hydrated).not.toContain(success)
		expect(judged).toEqual([["item.read"]])
	})

	it("counts a refusal its operation documents no schema for as judged, without a finding", async () => {
		const gate = seen("item.update", { body: GATE_BODY, status: 403 })
		const { findings, judged } = await judge([gate], fine, {}, { update: { "200": json(ITEM) } })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["item.read", "item.update"]])
	})

	it("counts a refusal on an operation missing from the document as judged, without a finding", async () => {
		const model = modelOfItems()
		const staged = overTranscript(model, [seen("item.create", { body: {}, status: 409 })], { respond: () => fine })
		const plan = errorSchemaHonoured.plan(staged.ctx)
		if (!plan.ok) throw new Error("the error-schema plan did not apply")
		model.rawOperations.delete("item.create")
		const judged: string[][] = []
		await errorSchemaHonoured.run({ ...staged.ctx, judged: (ids) => judged.push([...ids]) }, plan.value)
		expect(staged.findings.findings).toEqual([])
		expect(judged).toEqual([["item.read", "item.create"]])
		expect(await errorSchemaHonoured.run(staged.ctx, plan.value)).toEqual({
			kind: "asserted",
		})
	})
})
