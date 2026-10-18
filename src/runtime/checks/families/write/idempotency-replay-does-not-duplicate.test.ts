import { describe, expect, it, vi } from "vitest"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { CheckContext } from "../../core/context.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { idempotentReplay } from "./idempotency-replay-does-not-duplicate.ts"
import {
	overriding,
	type Rows,
	WIDGET,
	widgetApi,
	widgetDoc,
	type WidgetDocOptions,
} from "./__fixtures__/widget-api.ts"

const KEY_HEADER = { in: "header", name: "Idempotency-Key", schema: { type: "string" } }

function stage(respond: Responder, options: WidgetDocOptions = {}, create: Partial<OperationModel> = {}) {
	const model = modelOf(widgetDoc({ createParameters: [KEY_HEADER], ...options }))
	return contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: { ...op(model, "createWidget"), ...create },
			readOp: op(model, "getWidget"),
		},
	})
}

const keyOf = (headers: unknown): string | undefined => (headers as Record<string, string>)["Idempotency-Key"]

/** A backend that answers a repeated key with the first answer, and makes nothing new. */
function honoringKeys(rows: Rows = new Map()): Responder {
	const api = widgetApi(rows)
	const answered = new Map<string, Answer | undefined>()
	return (method, path, options) => {
		const key = method === "POST" ? keyOf(options.headers) : undefined
		if (key === undefined) return api(method, path, options)
		if (!answered.has(key)) answered.set(key, api(method, path, options))
		return answered.get(key)
	}
}

/** Answers the `nth` POST (1-based) with `answer`; the rest reach `backend`. */
function onPost(nth: number, answer: Answer, backend: Responder = widgetApi()): Responder {
	let posts = 0
	return overriding(backend, (method) => {
		if (method !== "POST") return undefined
		posts += 1
		return posts === nth ? answer : undefined
	})
}

const GATED = { body: { vars: { type: "feature_gate" } }, status: 403 }

describe("idempotency.replay-does-not-duplicate verdicts", () => {
	it("passes a replay that answers the original record and makes nothing new", async () => {
		const { ctx, findings, sent } = stage(honoringKeys())
		expect(await runCheck(idempotentReplay, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		const posts = sent.filter((s) => s.method === "POST")
		expect(posts).toHaveLength(2)
		expect(keyOf(posts[0]?.options.headers)).toBe("oat-idem-test-widget")
		expect(posts[1]?.options.body).toEqual(posts[0]?.options.body)
	})

	it("reports a replay that ignores the key and creates a second record", async () => {
		const { ctx, findings } = stage(widgetApi())
		expect(await runCheck(idempotentReplay, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("replaying a request with the same idempotency key created a second record")
		expect(finding?.detail).toContain("produced widget w1 and w2")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("reports a replay that answers the original yet still inserts another, and ledgers the twin", async () => {
		const rows: Rows = new Map()
		const honest = honoringKeys(rows)
		let posts = 0
		const { ctx, findings } = stage((method, path, options) => {
			const answer = honest(method, path, options)
			if (method === "POST" && ++posts === 2) rows.set("twin", { id: "twin", name: "copy" })
			return answer
		})
		const recordCreated = vi.fn<NonNullable<CheckContext["recordCreated"]>>()
		expect(await runCheck(idempotentReplay, { ...ctx, recordCreated })).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(findings.findings[0]?.summary).toBe("replaying a request with the same idempotency key grew the collection")
		expect(findings.findings[0]?.detail).toContain("the collection went from 1 to 2 records")
		expect(findings.findings[0]?.evidence).toHaveLength(4)
		expect(recordCreated).toHaveBeenCalledTimes(1)
		expect(recordCreated.mock.calls[0]?.[0]).toEqual({ entity: "widget", id: "twin", scope: {} })
		/* Without a ledger the finding still stands. */
		const { ctx: unledgered } = stage((method, path, options) => {
			const answer = honest(method, path, options)
			if (method === "POST") rows.set(`twin${rows.size}`, { id: `twin${rows.size}` })
			return answer
		})
		expect((await runCheck(idempotentReplay, unledgered)).kind).toBe("finding")
	})
})

describe("idempotency.replay-does-not-duplicate identities and gates", () => {
	it("matches an acknowledgement-only create by the client-chosen id a read confirms", async () => {
		const item = { ...WIDGET, properties: { ...(WIDGET.properties as object), id: { type: "string" } } }
		const rows: Rows = new Map()
		const honest = honoringKeys(rows)
		const acknowledging: Responder = (method, path, options) => {
			const answer = honest(method, path, options)
			return method === "POST" ? { body: null, status: 202 } : answer
		}
		const { ctx, findings, sent } = stage(acknowledging, { item })
		expect(await runCheck(idempotentReplay, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.some((s) => s.method === "GET" && s.path.startsWith("/widgets/"))).toBe(true)
	})

	it("matches a numeric id on both answers as one record", async () => {
		const numeric = overriding(honoringKeys(), (method) =>
			method === "POST" ? { body: { id: 41, name: "n" }, status: 201 } : undefined,
		)
		const { ctx, findings } = stage(numeric)
		expect(await runCheck(idempotentReplay, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("stands down when a documented feature gate refuses either create", async () => {
		for (const nth of [1, 2]) {
			const { ctx, findings } = stage(onPost(nth, GATED, honoringKeys()), {}, { featureGate: "beta" })
			expect(await runCheck(idempotentReplay, ctx)).toEqual({
				kind: "stood-down",
				reason: "a documented feature gate refused the request",
			})
			expect(findings.byVerdict("COVERAGE_GAP")).toHaveLength(1)
		}
	})
})

describe("idempotency.replay-does-not-duplicate preconditions", () => {
	it("is unresolved when the first create fails, or the replay is refused", async () => {
		const { ctx } = stage(onPost(1, { status: 500 }))
		expect(await runCheck(idempotentReplay, ctx)).toEqual({
			kind: "unresolved",
			reason: "the first create returned 500, so there was nothing to replay",
		})
		const { ctx: refused } = stage(onPost(2, { status: 409 }))
		expect(await runCheck(idempotentReplay, refused)).toEqual({
			kind: "unresolved",
			reason: "the replay returned 409; a repeated key must be answered, not refused",
		})
	})

	it("is unresolved when no identity names the first create or the replay", async () => {
		const { ctx } = stage(onPost(1, { body: {}, status: 201 }))
		expect(await runCheck(idempotentReplay, ctx)).toEqual({
			kind: "unresolved",
			reason: 'the create response carries no "id", so a replay cannot be matched to it',
		})
		const { ctx: anonymousReplay } = stage(onPost(2, { status: 200 }))
		expect(await runCheck(idempotentReplay, anonymousReplay)).toEqual({
			kind: "unresolved",
			reason: `the replay's response carries no "id", so it cannot be matched to the original`,
		})
	})

	it("is unresolved when the collection cannot be read whole around the replay", async () => {
		const reason = "the collection could not be read whole around the replay, so growth was not ruled out"
		for (const failingList of [1, 2]) {
			let lists = 0
			const respond = overriding(honoringKeys(), (method, path) =>
				method === "GET" && path === "/widgets" && ++lists === failingList ? { status: 500 } : undefined,
			)
			const { ctx } = stage(respond)
			expect(await runCheck(idempotentReplay, ctx)).toEqual({ kind: "unresolved", reason })
		}
	})

	it("applies only to a create with a body that declares an idempotency-key header", () => {
		expect(idempotentReplay.plan(stage(widgetApi()).ctx).ok).toBe(true)
		expect(idempotentReplay.plan(stage(widgetApi(), { createParameters: [] }).ctx).ok).toBe(false)
		expect(idempotentReplay.plan({ ...stage(widgetApi()).ctx, createOp: undefined }).ok).toBe(false)
		const { ctx } = stage(widgetApi())
		const bodiless = { ...ctx, model: { ...ctx.model, rawOperations: new Map() } }
		expect(idempotentReplay.plan(bodiless)).toEqual({
			needs: "a create operation with a request body to replay",
			ok: false,
		})
	})
})
