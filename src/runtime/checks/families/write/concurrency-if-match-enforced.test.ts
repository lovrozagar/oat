import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../../../client/types.ts"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { ifMatchEnforced } from "./concurrency-if-match-enforced.ts"
import { overriding, type Rows, widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

type Json = Record<string, unknown>

/** What the document declares beyond the widget's routes: an ETag on the read, If-Match on the update. */
interface Declared {
	etag?: boolean
	ifMatch?: boolean
	updateBody?: boolean
}

/* The widget document, with the read's ETag header and the update's If-Match parameter and 412. */
function preconditionDoc(options: WidgetDocOptions, declared: Declared): OpenApiDocument {
	const doc = widgetDoc(options) as unknown as { paths: Record<string, Record<string, Json | undefined>> }
	const route = doc.paths["/widgets/{id}"] ?? {}
	const read = route.get as { responses: Record<string, Json> } | undefined
	if (declared.etag !== false && read !== undefined)
		read.responses["200"] = { ...read.responses["200"], headers: { ETag: {} } }
	const update = (route.patch ?? route.put) as Json | undefined
	if (update !== undefined && declared.ifMatch !== false) {
		update.parameters = [{ in: "header", name: "If-Match", schema: { type: "string" } }]
		;(update.responses as Json)["412"] = { description: "stale" }
	}
	if (update !== undefined && declared.updateBody === false) delete update.requestBody
	return doc as unknown as OpenApiDocument
}

function stage(respond: Responder, options: WidgetDocOptions = {}, declared: Declared = {}) {
	const model = modelOf(preconditionDoc(options, declared))
	return contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: op(model, "createWidget"),
			readOp: model.byOperationId.get("getWidget"),
			updateOp: model.byOperationId.get("updateWidget"),
		},
	})
}

/* The If-Match a request carried, when it carried one. */
function ifMatchOf(options: Omit<RequestOptions, "as">): string | undefined {
	const headers = typeof options.headers === "function" ? options.headers() : (options.headers ?? {})
	return headers["If-Match"]
}

/** How a versioned backend misbehaves, if it does. */
interface Versioning {
	/** Answers a stale If-Match with this status instead of 412, and applies the write. */
	ignore?: number
	/** Answers 412 and applies the write anyway. */
	landsAnyway?: boolean
	/** Answers a stale If-Match 200 and changes nothing. */
	alreadyApplied?: boolean
	/** Writes leave the version where it was. */
	frozen?: boolean
	/** Tags are weak. */
	weak?: boolean
	/** The read sends no ETag. */
	untagged?: boolean
}

const PROBLEM = { headers: { "content-type": "application/problem+json" }, status: 412 }

/* The widget backend with a version per record: the read tags it, a write moves it, a stale If-Match is 412. */
function versioned(how: Versioning = {}, rows: Rows = new Map()): Responder {
	const backend = widgetApi(rows)
	const versions = new Map<string, number>()
	const tag = (id: string): string => `${how.weak === true ? "W/" : ""}"v${versions.get(id) ?? 0}"`
	const bump = (id: string): void => {
		if (how.frozen !== true) versions.set(id, (versions.get(id) ?? 0) + 1)
	}
	return (method, path, options) => {
		const answer = backend(method, path, options)
		if (path === "/widgets" || answer === undefined) return answer
		const id = decodeURIComponent(path.slice("/widgets/".length))
		if (method === "GET") return how.untagged === true ? answer : { ...answer, headers: { etag: tag(id) } }
		const sent = ifMatchOf(options)
		if (sent === undefined || sent === tag(id)) {
			bump(id)
			return answer
		}
		return staleAnswer(how, answer, () => bump(id))
	}
}

/* How the versioned backend answers a write under a stale If-Match: as `how` says, else 412. */
function staleAnswer(how: Versioning, answer: Answer, bump: () => void): Answer {
	if (how.alreadyApplied === true) return { ...answer, status: 200 }
	if (how.landsAnyway !== true && how.ignore === undefined) return PROBLEM
	bump()
	return how.ignore === undefined ? PROBLEM : { ...answer, status: how.ignore }
}

/** Answers the `nth` write (1-based) with `answer`; everything else reaches `backend`. */
function writing(nth: number, answer: Answer, backend: Responder = versioned()): Responder {
	let writes = 0
	return overriding(backend, (method) => {
		if (method !== "PATCH" && method !== "PUT") return undefined
		writes += 1
		return writes === nth ? answer : undefined
	})
}

/** Answers the item read with `answer` from the `nth` read on (1-based). */
function readingFrom(nth: number, answer: Answer): Responder {
	let reads = 0
	return overriding(versioned(), (method, path) => {
		if (method !== "GET" || path === "/widgets") return undefined
		reads += 1
		return reads >= nth ? answer : undefined
	})
}

const GATED = { body: { vars: { feature: "beta", type: "feature_gate" } }, status: 403 }

describe("concurrency.if-match-enforced verdicts", () => {
	it("passes when an update naming a stale ETag is refused with 412 and the record stays as it was", async () => {
		const { ctx, findings, sent } = stage(versioned())
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => `${s.method} ${ifMatchOf(s.options) ?? "-"}`)).toEqual([
			"POST -",
			"GET -",
			'PATCH "v0"',
			"GET -",
			'PATCH "v0"',
			"GET -",
		])
		/* Both updates carry the record as read: its writable fields, never its server-issued id. */
		const [created, , first, , second] = sent
		const made = created?.options.body as Json
		expect(first?.options.body).toEqual({ label: made.label, name: made.name, note: made.note })
		expect(second?.options.body).toEqual(first?.options.body)
	})

	it("reports a stale If-Match the update ignores, applying the write", async () => {
		const { ctx, findings } = stage(versioned({ ignore: 200 }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("an update naming a stale ETag in If-Match was applied")
		expect(finding?.detail).toContain('read with ETag "v0"')
		expect(finding?.detail).toContain('moved its ETag to "v1"')
		expect(finding?.detail).toContain('answered 200, and the record\'s ETag moved again, to "v2"')
		expect(finding?.evidence.map((e) => e.method)).toEqual(["PATCH", "GET"])
	})

	it("reports an update refused with 412 that still lands", async () => {
		const { ctx, findings } = stage(versioned({ landsAnyway: true }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("an update refused with 412 was applied anyway")
		expect(finding?.detail).toContain('yet the record\'s ETag moved from "v1" to "v2"')
	})

	it("passes, noting it, a stale update answered as already applied that changes nothing", async () => {
		const { ctx, findings } = stage(versioned({ alreadyApplied: true }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({
			kind: "asserted",
			note:
				"an update naming a stale ETag answered 200 and left the record as it was, which RFC 9110 allows " +
				"when the change it asks for is already applied",
		})
		expect(findings.findings).toEqual([])
	})
})

describe("concurrency.if-match-enforced bodies", () => {
	it("sends a PUT the whole representation, the same body both times", async () => {
		const { ctx, sent } = stage(versioned(), { update: "put" })
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "asserted" })
		const puts = sent.filter((s) => s.method === "PUT").map((s) => s.options.body as Json)
		expect(puts).toHaveLength(2)
		expect(puts[0]).toEqual(puts[1])
		expect(Object.keys(puts[0] ?? {}).toSorted()).toEqual(["label", "name", "note"])
	})

	it("sends an update with no request body an empty one", async () => {
		const { ctx, sent } = stage(versioned(), {}, { updateBody: false })
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "asserted" })
		expect(sent.filter((s) => s.method === "PATCH").map((s) => s.options.body)).toEqual([{}, {}])
	})
})

describe("concurrency.if-match-enforced when nothing can be judged", () => {
	it("stands down on a weak ETag, which cannot satisfy If-Match", async () => {
		const { ctx, findings, sent } = stage(versioned({ weak: true }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({
			kind: "stood-down",
			reason: "a weak ETag cannot satisfy If-Match",
		})
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => s.method)).toEqual(["POST", "GET"])
	})

	it("stands down when the update leaves the ETag where it was, so it never went stale", async () => {
		const { ctx } = stage(versioned({ frozen: true }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({
			kind: "stood-down",
			reason: "the update left the ETag unchanged, so the ETag it named never went stale",
		})
	})

	it("stands down on a documented feature gate or a rate limit on either update", async () => {
		for (const nth of [1, 2]) {
			const { ctx: gated } = stage(writing(nth, GATED))
			gated.updateOp = { ...(gated.updateOp ?? op(gated.model, "updateWidget")), featureGate: "beta" }
			expect(await runCheck(ifMatchEnforced, gated)).toEqual({
				kind: "stood-down",
				reason: "a documented feature gate refused the request",
			})
			const { ctx: limited } = stage(writing(nth, { status: 429 }))
			expect(await runCheck(ifMatchEnforced, limited)).toEqual({
				kind: "stood-down",
				reason: "the request was rate limited",
			})
		}
	})
})

describe("concurrency.if-match-enforced unresolved", () => {
	it("is unresolved when an update is answered neither as the precondition asks nor with success", async () => {
		const { ctx: current } = stage(writing(1, { status: 400 }))
		expect(await runCheck(ifMatchEnforced, current)).toEqual({
			kind: "unresolved",
			reason: "an update naming the record's current ETag answered 400, so no accepted write left it stale",
		})
		const { ctx: stale } = stage(writing(2, { status: 409 }))
		expect(await runCheck(ifMatchEnforced, stale)).toEqual({
			kind: "unresolved",
			reason: "an update naming a stale ETag answered 409, neither 412 nor a success",
		})
	})

	it("is unresolved when a read fails, holds no record, or carries no ETag", async () => {
		const cases: Array<[number, Answer, string]> = [
			[1, { status: 500 }, "reading the record before any update returned 500"],
			[1, { body: ["no", "record"], status: 200 }, "the answer holds no record where x-entity.recordPath says it is"],
			[2, { body: { id: "w1", name: "n" }, status: 200 }, "the item read after the first update carried no ETag"],
			[3, { status: 404 }, "reading the record after the stale update returned 404"],
		]
		for (const [nth, answer, reason] of cases) {
			const { ctx } = stage(readingFrom(nth, answer))
			expect(await runCheck(ifMatchEnforced, ctx)).toEqual({ kind: "unresolved", reason })
		}
		const { ctx } = stage(versioned({ untagged: true }))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({
			kind: "unresolved",
			reason: "the item read before any update carried no ETag",
		})
	})

	it("is unresolved when the scratch record cannot be made", async () => {
		const { ctx } = stage(overriding(versioned(), (method) => (method === "POST" ? { status: 500 } : undefined)))
		expect(await runCheck(ifMatchEnforced, ctx)).toEqual({
			kind: "unresolved",
			reason: "a record for this check could not be made: the create answered 500",
		})
	})
})

describe("concurrency.if-match-enforced plan", () => {
	it("applies to a create, an item read declaring an ETag, and an update declaring If-Match", () => {
		expect(ifMatchEnforced.plan(stage(versioned()).ctx).ok).toBe(true)
		expect(ifMatchEnforced.plan(stage(versioned(), {}, { etag: false }).ctx)).toEqual({
			needs: "an item read whose success response declares an ETag header",
			ok: false,
		})
		expect(ifMatchEnforced.plan(stage(versioned(), {}, { ifMatch: false }).ctx)).toEqual({
			needs: "an update that declares an If-Match header",
			ok: false,
		})
		expect(ifMatchEnforced.plan(stage(versioned(), { update: null }).ctx).ok).toBe(false)
		expect(ifMatchEnforced.plan(stage(versioned(), { read: false }).ctx).ok).toBe(false)
		expect(ifMatchEnforced.plan({ ...stage(versioned()).ctx, createOp: undefined }).ok).toBe(false)
	})

	it("grades the update and the item read", () => {
		const { ctx } = stage(versioned())
		const entity = ctx.model.entities.get(ctx.entityName)
		if (entity === undefined) throw new Error("expected the widget entity")
		expect(ifMatchEnforced.subjects(entity, ctx.model)).toEqual(["updateWidget", "getWidget"])
	})
})
