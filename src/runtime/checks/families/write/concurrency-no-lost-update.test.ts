import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { noLostUpdate } from "./concurrency-no-lost-update.ts"
import { overriding, type Rows, widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

function stage(respond: Responder, options: WidgetDocOptions = {}, update: Partial<OperationModel> = {}) {
	const model = modelOf(widgetDoc(options))
	const updateOp = model.byOperationId.get("updateWidget")
	return contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: op(model, "createWidget"),
			readOp: model.byOperationId.get("getWidget"),
			updateOp: updateOp === undefined ? undefined : { ...updateOp, ...update },
		},
	})
}

const GATED = { body: { vars: { feature: "beta", type: "feature_gate" } }, status: 403 }

/** Answers the PATCH that writes `field` with `answer`; everything else reaches the backend. */
function patching(field: string, answer: { status: number; body?: unknown }): Responder {
	return overriding(widgetApi(), (method, _, options) =>
		method === "PATCH" && field in (options.body as object) ? answer : undefined,
	)
}

/** Answers the item read with `answer` from the `nth` read on (1-based). */
function readingFrom(nth: number, answer: { status: number; body?: unknown }): Responder {
	let readsSeen = 0
	return overriding(widgetApi(), (method, path) => {
		if (method !== "GET" || path === "/widgets") return undefined
		readsSeen += 1
		return readsSeen >= nth ? answer : undefined
	})
}

describe("concurrency.no-lost-update verdicts", () => {
	it("passes when both concurrent patches to different fields survive", async () => {
		const { ctx, findings, sent } = stage(widgetApi())
		expect(await runCheck(noLostUpdate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		const patches = sent.filter((s) => s.method === "PATCH").map((s) => s.options.body)
		expect(patches).toEqual([{ label: "oat-concurrent-a" }, { name: "oat-concurrent-b" }])
	})

	it("reports a patch that writes back the row it read, reverting the other write", async () => {
		/* Read-modify-write: each PATCH applies its field to the row as created, not as it is now. */
		const rows: Rows = new Map()
		const created = new Map<string, Record<string, unknown>>()
		const api = widgetApi(rows)
		const { ctx, findings } = stage((method, path, options) => {
			const id = path.slice("/widgets/".length)
			if (method === "PATCH") {
				const stale = { ...created.get(id), ...(options.body as object) }
				rows.set(id, stale)
				return { body: stale, status: 200 }
			}
			const answer = api(method, path, options)
			const body = answer?.body as { id: string } | undefined
			if (method === "POST" && body !== undefined) created.set(body.id, { ...body })
			return answer
		})
		expect(await runCheck(noLostUpdate, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a concurrent write to a different field was silently lost")
		expect(finding?.detail).toContain('two simultaneous patches set "label" and "name"')
		expect(finding?.detail).toContain("but label read back as")
		expect(finding?.evidence.map((e) => e.method)).toEqual(["PATCH", "PATCH", "GET"])
	})

	it("reports both fields when neither write is kept", async () => {
		const ignoring = overriding(widgetApi(), (method) => (method === "PATCH" ? { body: {}, status: 200 } : undefined))
		const { ctx, findings } = stage(ignoring)
		expect(await runCheck(noLostUpdate, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("label and name read back as")
	})
})

describe("concurrency.no-lost-update when no race can be judged", () => {
	it("stands down on a documented feature gate on either write", async () => {
		for (const field of ["label", "name"]) {
			const { ctx, findings } = stage(patching(field, GATED), {}, { featureGate: "beta" })
			expect(await runCheck(noLostUpdate, ctx)).toEqual({
				kind: "stood-down",
				reason: "a documented feature gate refused the request",
			})
			expect(findings.byVerdict("COVERAGE_GAP")).toHaveLength(1)
		}
	})

	it("stands down when either write is rate limited", async () => {
		for (const field of ["label", "name"]) {
			const { ctx, findings } = stage(patching(field, { status: 429 }))
			expect(await runCheck(noLostUpdate, ctx)).toEqual({ kind: "stood-down", reason: "the request was rate limited" })
			expect(findings.inconclusive).toHaveLength(1)
		}
	})

	it("is unresolved when a concurrent patch is refused, since no race took place", async () => {
		const { ctx } = stage(patching("name", { status: 400 }))
		expect(await runCheck(noLostUpdate, ctx)).toEqual({
			kind: "unresolved",
			reason: "a concurrent PATCH was rejected (200, 400), so no race actually took place",
		})
		const { ctx: first } = stage(patching("label", { status: 409 }))
		expect((await runCheck(noLostUpdate, first)).kind).toBe("unresolved")
	})

	it("is unresolved when the record cannot be read before or after the race", async () => {
		const cases: Array<[number, { status: number; body?: unknown }, string]> = [
			[1, { status: 500 }, "reading the record back returned 500, so there was no baseline to race against"],
			[
				1,
				{ body: ["not", "a", "record"], status: 200 },
				"the answer holds no record where x-entity.recordPath says it is",
			],
			[2, { status: 404 }, "reading the record back after the race returned 404"],
			[2, { body: "gone", status: 200 }, "the answer holds no record where x-entity.recordPath says it is"],
		]
		for (const [nth, answer, reason] of cases) {
			/* The create answers with its id, so the first item read is the baseline and the second the after. */
			const { ctx } = stage(readingFrom(nth, answer))
			expect(await runCheck(noLostUpdate, ctx)).toEqual({ kind: "unresolved", reason })
		}
	})

	it("is unresolved when the scratch record cannot be made", async () => {
		const { ctx } = stage(overriding(widgetApi(), (method) => (method === "POST" ? { status: 500 } : undefined)))
		expect(await runCheck(noLostUpdate, ctx)).toEqual({
			kind: "unresolved",
			reason: "a record for this check could not be made: the create answered 500",
		})
	})
})

describe("concurrency.no-lost-update fields and plan", () => {
	it("races only fields an arbitrary string may legitimately be written into", async () => {
		const item = {
			properties: {
				code: { pattern: "^[A-Z]+$", type: "string" },
				email: { format: "email", type: "string" },
				fixed: { type: "string" },
				id: { readOnly: true, type: "string" },
				name: { type: "string" },
				short: { maxLength: 10, type: "string" },
				status: { enum: ["open", "shut"], type: "string" },
				wide: { maxLength: 64, type: "string" },
			},
			type: "object",
		}
		const record = {
			code: "AB",
			count: 3,
			created_at: "now",
			email: "a@b.c",
			extra: "not in the update body",
			fixed: "set once",
			id: "w1",
			name: "n",
			owner_id: "o",
			short: "s",
			status: "open",
		}
		const respond = readingFrom(1, { body: record, status: 200 })
		const { ctx } = stage(respond, { item }, { immutable: ["fixed"] })
		expect(await runCheck(noLostUpdate, ctx)).toEqual({
			kind: "unresolved",
			reason:
				"only 1 writable string field(s) are present on the record; two are needed so the concurrent writes " +
				"cannot legitimately clobber each other",
		})
		/* With no update body to enumerate, any free string on the record is a candidate. */
		const { ctx: unknownBody } = stage(respond, { item })
		const plan = noLostUpdate.plan(unknownBody)
		if (!plan.ok) throw new Error("expected the check to apply")
		expect(await noLostUpdate.run({ ...unknownBody, updateOp: undefined }, plan.value)).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
	})

	it("applies only to a PATCH update with a create and an item read", () => {
		expect(noLostUpdate.plan(stage(widgetApi()).ctx).ok).toBe(true)
		expect(noLostUpdate.plan(stage(widgetApi(), { update: "put" }).ctx)).toEqual({
			needs: "an update by PATCH, whose writes are partial",
			ok: false,
		})
		expect(noLostUpdate.plan(stage(widgetApi(), { update: null }).ctx).ok).toBe(false)
		expect(noLostUpdate.plan(stage(widgetApi(), { read: false }).ctx).ok).toBe(false)
		expect(noLostUpdate.plan({ ...stage(widgetApi()).ctx, createOp: undefined }).ok).toBe(false)
	})
})

/* The check's plan over an update body of these properties; `undefined`, a body that lists none. */
const planned = (properties?: Record<string, unknown>) =>
	noLostUpdate.plan(
		stage(widgetApi(), { item: { ...(properties === undefined ? {} : { properties }), type: "object" } }).ctx,
	)

describe("concurrency.no-lost-update and an update body with too few writable strings", () => {
	const readOnlyId = { id: { readOnly: true, type: "string" } }

	it("stands down before any request, naming the one field the update takes, or none", () => {
		const code = { enum: ["a", "b"], type: "string" }
		expect(planned({ ...readOnlyId, code, count: { type: "integer" }, name: { type: "string" } })).toEqual({
			needs: "two independently writable string fields; widget's update takes only name",
			ok: false,
		})
		expect(planned(readOnlyId)).toEqual({
			needs: "two independently writable string fields; widget's update takes none",
			ok: false,
		})
	})

	it("leaves a body that lists no properties to the record a run reads", () => {
		expect(planned().ok).toBe(true)
	})

	it("counts a property that names no type, or a type list with string in it", () => {
		expect(planned({ ...readOnlyId, label: {}, name: { type: "string" } }).ok).toBe(true)
		expect(planned({ ...readOnlyId, name: { type: "string" }, nick: { type: ["string", "null"] } }).ok).toBe(true)
	})
})

describe("concurrency.no-lost-update under a guard pattern on every string", () => {
	const guard = "^[^\\u0000\\uD800-\\uDFFF]*$"
	const readOnlyId = { id: { readOnly: true, type: "string" } }

	it("races strings whose patterns admit the race's values", () => {
		const guarded = { pattern: guard, type: "string" }
		expect(planned({ ...readOnlyId, name: guarded, title: guarded }).ok).toBe(true)
	})

	it("leaves out a string whose own pattern in an allOf refuses the race's values", () => {
		const country = { allOf: [{ pattern: "^[A-Z]{2}$" }, { pattern: guard }], type: "string" }
		expect(planned({ ...readOnlyId, country, name: { pattern: guard, type: "string" } })).toEqual({
			needs: "two independently writable string fields; widget's update takes only name",
			ok: false,
		})
	})
})
