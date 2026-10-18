import { describe, expect, it, vi } from "vitest"
import type { EffectSpec } from "../../../../spec/extensions/effects.ts"
import type { CheckContext } from "../../core/context.ts"
import { contextFor, exchange, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { baseDocument, routes, withOperation } from "./__fixtures__/documents.ts"
import { type ActionRun, judgeEffects, missingParams, reportGap } from "./effect-verdicts.ts"
import type { Observation } from "./observe.ts"

const doc = withOperation(baseDocument(), "/widgets/{id}/act", "post", { operationId: "actOnWidget" })
const model = modelOf(doc)
const CHECK = "effects.declared-effect-occurs"

const rows = (...ids: string[]) => ({ body: ids.map((id) => ({ id, name: id })), status: 200 })
const seen = (...ids: string[]): Observation => ({ exchange: exchange("GET", "/", { status: 200 }), ids, status: "ok" })
const failed = (reason: string): Observation => ({
	exchange: exchange("GET", "/", { status: 503 }),
	reason,
	status: "error",
})

interface Setup {
	befores?: Record<string, Observation>
	scope?: Record<string, string>
	body?: unknown
	tracked?: boolean
}

/** Judges `effects` of a succeeded `actOnWidget` against a server answering through `respond`. */
async function judge(respond: Responder, effects: EffectSpec[], setup: Setup = {}) {
	const recordCreated = vi.fn<NonNullable<CheckContext["recordCreated"]>>()
	const stage = contextFor(model, "listWidgets", respond, setup.tracked === false ? {} : { recordCreated })
	const action: ActionRun = {
		befores: new Map(Object.entries(setup.befores ?? {})),
		check: CHECK,
		ctx: stage.ctx,
		effects,
		fixture: undefined,
		invoked: { ...exchange("POST", "/widgets/w1/act", { body: setup.body ?? {}, status: 200 }), principal: "owner" },
		op: op(model, "actOnWidget"),
		scope: setup.scope ?? { id: "w1" },
	}
	await judgeEffects(action)
	return { ...stage, action, recordCreated }
}

describe("missingParams", () => {
	it("lists the parameters the scope cannot fill, in path order", () => {
		expect(missingParams(["org", "id", "part"], { id: "w1" })).toBe("missing {org}, {part}")
	})
})

describe("reportGap", () => {
	it("reports a coverage gap on the invocation's subject, naming the fixture", () => {
		const { ctx, findings } = contextFor(model, "listWidgets", () => undefined)
		reportGap({ check: CHECK, ctx, fixture: "a.png", op: op(model, "actOnWidget") }, "title", "detail")
		expect(findings.findings).toMatchObject([
			{ detail: "detail", entity: "actOnWidget · a.png", fixture: "a.png", summary: "title", verdict: "COVERAGE_GAP" },
		])
	})
})

describe("a create or append effect", () => {
	it("holds when the collection gained exactly the declared records, which are recorded and bound", async () => {
		const run = await judge(() => rows("w1", "w2"), [{ entity: "widget", op: "create" }], {
			befores: { widget: seen("w1") },
		})
		expect(run.findings.findings).toEqual([])
		expect(run.recordCreated).toHaveBeenCalledWith("widget", "w2", { id: "w1" }, "owner")
		expect(run.action.scope).toEqual({ id: "w2", widget_id: "w2" })
	})

	it("fails when the collection did not gain the declared record", async () => {
		const run = await judge(() => rows("w1"), [{ entity: "widget", op: "create" }], { befores: { widget: seen("w1") } })
		expect(run.findings.findings).toMatchObject([
			{
				check: CHECK,
				summary: 'actOnWidget did not produce the "widget" records it declares',
				verdict: "BACKEND_BUG",
			},
		])
		const [finding] = run.findings.findings
		expect(finding?.detail).toContain(
			'declares create × 1 on "widget", but the collection went from 1 to 1 (0 added, 0 removed)',
		)
		expect(finding?.evidence.map((e) => e.method)).toEqual(["POST", "GET"])
	})

	it("fails an append that gained fewer than its declared minimum, without binding anything", async () => {
		const run = await judge(() => rows("w1", "w2"), [{ entity: "widget", min: 2, op: "append" }], {
			befores: { widget: seen("w1") },
		})
		expect(run.findings.findings[0]?.detail).toContain('declares append ≥ 2 on "widget"')
		expect(run.recordCreated).toHaveBeenCalledWith("widget", "w2", { id: "w1" }, "owner")
		expect(run.action.scope).toEqual({ id: "w1" })
	})

	it("judges against an empty baseline when none was read, recording nothing when nothing records", async () => {
		const run = await judge(() => rows("w1"), [{ entity: "widget", op: "append" }], { tracked: false })
		expect(run.findings.findings).toEqual([])
	})
})

describe("a delete effect", () => {
	it("holds when the declared records left the collection", async () => {
		const run = await judge(() => rows("w1"), [{ entity: "widget", op: "delete" }], {
			befores: { widget: seen("w1", "w2") },
		})
		expect(run.findings.findings).toEqual([])
		expect(run.recordCreated).not.toHaveBeenCalled()
	})

	it("fails when nothing was removed", async () => {
		const run = await judge(() => rows("w1", "w2"), [{ entity: "widget", op: "delete" }], {
			befores: { widget: seen("w1", "w2") },
		})
		expect(run.findings.findings).toMatchObject([
			{
				detail: 'x-effects declares delete × 1 on "widget", but the collection went from 2 to 2',
				summary: 'actOnWidget did not remove the "widget" records it declares',
				verdict: "BACKEND_BUG",
			},
		])
	})
})

describe("an update or replace effect", () => {
	it("holds when the collection kept its size", async () => {
		const run = await judge(() => rows("w1"), [{ entity: "widget", op: "update" }], { befores: { widget: seen("w1") } })
		expect(run.findings.findings).toEqual([])
	})

	it("fails when the collection changed size", async () => {
		const run = await judge(() => rows("w1", "w9"), [{ entity: "widget", op: "replace" }], {
			befores: { widget: seen("w1") },
		})
		expect(run.findings.findings).toMatchObject([
			{
				detail: "x-effects declares replace, which must not add or remove records, but the collection went from 1 to 2",
				summary: 'actOnWidget changed the size of "widget" while declaring replace',
			},
		])
	})
})

const gaps = (run: Awaited<ReturnType<typeof judge>>) =>
	run.findings.findings.map((f) => ({ detail: f.detail, summary: f.summary, verdict: f.verdict }))

describe("an effect that cannot be observed", () => {
	it("is a gap when the entity has no list route", async () => {
		const run = await judge(() => undefined, [{ entity: "job", op: "create" }], { scope: {} })
		expect(gaps(run)).toEqual([
			{
				detail: "the effect cannot be observed, so it is not verified",
				summary: 'actOnWidget declares an effect on "job", which has no list route',
				verdict: "COVERAGE_GAP",
			},
		])
		expect(run.sent).toEqual([])
	})

	it("is a gap naming what the list path still lacks after the write", async () => {
		const run = await judge(() => undefined, [{ entity: "card", op: "append" }])
		expect(gaps(run)[0]?.detail).toBe("missing {board_id} after the write; the effect is unverified")
	})

	it("is a gap with the read's reason when the list fails after the write", async () => {
		const run = await judge(() => ({ status: 500 }), [{ entity: "widget", op: "update" }])
		expect(gaps(run)).toEqual([
			{
				detail: "page 1 was answered with 500; the declared effect is unverified",
				summary: 'actOnWidget could not observe "widget" after the write',
				verdict: "COVERAGE_GAP",
			},
		])
	})

	it("is a gap with the read's reason when only part of the collection could be read", async () => {
		const run = await judge(() => ({ body: [{ name: "e1" }], status: 200 }), [{ entity: "event", op: "update" }])
		expect(gaps(run)[0]?.detail).toBe("pages repeat the same records; the declared effect is unverified")
	})
})

describe("an effect without a baseline", () => {
	it("is a gap with the read's reason when the baseline read failed", async () => {
		const run = await judge(() => rows("w1"), [{ entity: "widget", op: "update" }], {
			befores: { widget: failed("pages repeat the same records") },
		})
		expect(gaps(run)).toEqual([
			{
				detail: `pages repeat the same records; no baseline, so the effect is unverified`,
				summary: 'actOnWidget could not observe "widget" before the write',
				verdict: "COVERAGE_GAP",
			},
		])
	})
})

describe("a created parent", () => {
	it("is found in its collection's delta, so the children's list can be read under it", async () => {
		const respond = routes({ "GET /boards": () => rows("b0", "b1"), "GET /boards/b1/cards": () => rows("c1") })
		const run = await judge(
			respond,
			[
				{ entity: "board", op: "create" },
				{ entity: "card", op: "append" },
			],
			{
				befores: { board: seen("b0") },
				scope: {},
			},
		)
		expect(run.findings.findings).toEqual([])
		expect(run.action.scope).toMatchObject({ board_id: "b1" })
		expect(run.recordCreated).toHaveBeenCalledWith("card", "c1", expect.objectContaining({ board_id: "b1" }), "owner")
	})

	it("is taken from the response when the response names it, without a second read", async () => {
		const respond = routes({ "GET /boards": () => rows("b0", "b1"), "GET /boards/b1/cards": () => rows("c1") })
		const run = await judge(
			respond,
			[
				{ entity: "board", op: "create" },
				{ entity: "card", op: "append" },
			],
			{
				befores: { board: seen("b0") },
				body: { board_id: "b1" },
				scope: {},
			},
		)
		expect(run.findings.findings).toEqual([])
		expect(run.sent.map((s) => s.path)).toEqual(["/boards", "/boards/b1/cards"])
	})
})

describe("a created parent without a baseline", () => {
	it("is bound from its whole collection when no baseline was read", async () => {
		const respond = routes({ "GET /boards": () => rows("b1"), "GET /boards/b1/cards": () => rows("c1") })
		const run = await judge(
			respond,
			[
				{ entity: "board", op: "create" },
				{ entity: "card", op: "append" },
			],
			{
				scope: {},
			},
		)
		expect(run.findings.findings).toEqual([])
		expect(run.action.scope).toMatchObject({ board_id: "b1" })
	})

	it("stays unbound when its collection cannot be read, leaving its children unverified", async () => {
		const respond = routes({ "GET /boards": () => ({ status: 500 }) })
		const run = await judge(
			respond,
			[
				{ entity: "board", op: "create" },
				{ entity: "card", op: "append" },
			],
			{
				scope: {},
			},
		)
		expect(run.findings.findings.map((f) => f.summary)).toEqual([
			'actOnWidget could not observe "board" after the write',
			'actOnWidget declares an effect on "card", but the list path cannot be filled',
		])
	})
})
