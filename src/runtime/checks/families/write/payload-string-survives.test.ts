import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { REQUIRED_IDS, STRING_PAYLOADS } from "../../../payloads.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import type { Listed } from "../../core/context.ts"
import { runCheck } from "../../core/run.ts"
import { ASCII_PAYLOAD_PROBE, writePathOf } from "./payload-cases.ts"
import { PayloadClaims } from "./payload-claims.ts"
import { stringPayloadSurvives } from "./payload-string-survives.ts"
import { overriding, type Rows, widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

function stage(respond: Responder, options: WidgetDocOptions = {}, fields: Partial<Listed> = {}) {
	const model = modelOf(widgetDoc(options))
	return contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: op(model, "createWidget"),
			deleteOp: model.byOperationId.get("deleteWidget"),
			readOp: model.byOperationId.get("getWidget"),
			updateOp: model.byOperationId.get("updateWidget"),
			...fields,
		},
	})
}

/* The field the probe writes: `note`, the nullable string. */
const noteOf = (body: unknown): unknown => (body as { note?: unknown } | undefined)?.note
const GERMAN = STRING_PAYLOADS.find((payload) => payload.id === "german")?.value
const GATED = { body: { vars: { type: "feature_gate" } }, status: 403 }

/** Answers every write of `value` to `note` with `answer`; the rest reach a correct backend. */
function writing(value: unknown, answer: { status: number; body?: unknown }, rows?: Rows): Responder {
	return overriding(widgetApi(rows), (method, _, options) =>
		method !== "GET" && noteOf(options.body) === value ? answer : undefined,
	)
}

const CREATE_ONLY = { update: null } as const

const unresolved = (reason: string) => ({ kind: "unresolved", reason })

describe("payload.string-survives through an update", () => {
	it("passes a backend that keeps every documented-valid string exactly", async () => {
		const { ctx, findings, sent } = stage(widgetApi())
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		/* One scratch record per lane, the ASCII control first, then the whole fitting catalog. */
		expect(sent.filter((s) => s.method === "POST")).toHaveLength(4)
		const patched = sent.filter((s) => s.method === "PATCH").map((s) => noteOf(s.options.body))
		expect(patched[0]).toBe(ASCII_PAYLOAD_PROBE)
		expect(new Set(patched.slice(1))).toEqual(new Set(STRING_PAYLOADS.map((payload) => payload.value)))
		expect(new Set(sent.filter((s) => s.method === "PATCH").map((s) => s.path)).size).toBe(4)
	})

	it("reports a backend that strips non-ASCII and surrounding whitespace on write", async () => {
		const rows: Rows = new Map()
		const api = widgetApi(rows)
		const mangling: Responder = (method, path, options) => {
			const note = noteOf(options.body)
			if (method !== "PATCH" || typeof note !== "string") return api(method, path, options)
			const stripped = note.replace(/[^\x20-\x7e]/g, "").trim()
			return api(method, path, { ...options, body: { note: stripped } })
		}
		const { ctx, findings } = stage(mangling)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a documented-valid string did not survive a write")
		expect(finding?.detail).toMatch(/"note" failed \d+ payload case\(s\): .*; and \d+ more\. /)
		expect(finding?.detail).toContain('space (single ASCII space): sent " ", got ""')
		expect(finding?.evidence).toHaveLength(4)
	})

	it("reports a row that is never served back, not even to its creator", async () => {
		const rows: Rows = new Map()
		const hiding = overriding(widgetApi(rows), (method, path) =>
			method === "GET" && noteOf(rows.get(path.slice("/widgets/".length))) === ASCII_PAYLOAD_PROBE
				? { status: 404 }
				: undefined,
		)
		const { ctx, findings } = stage(hiding)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("an ordinary ASCII write did not persist exactly")
		expect(findings.findings[0]?.detail).toBe(`"note" was sent "oat-payload-probe" and read back undefined.`)
	})
})

describe("payload.string-survives refusals through an update", () => {
	it("judges nothing past a control write the backend refuses or fails", async () => {
		const cases: Array<[{ status: number; body?: unknown }, unknown]> = [
			[
				{ status: 401 },
				unresolved("the ASCII control write returned 401, so later refusals cannot be attributed to the payload"),
			],
			[
				{ status: 403 },
				unresolved("the ASCII control write returned 403, so later refusals cannot be attributed to the payload"),
			],
			[
				{ status: 422 },
				unresolved("the ASCII control write was rejected with 422, so the field refuses ordinary strings"),
			],
			[{ status: 429 }, { kind: "stood-down", reason: "the request was rate limited" }],
			[{ status: 503 }, { kind: "finding", verdict: "BACKEND_BUG" }],
		]
		for (const [answer, outcome] of cases) {
			const { ctx, sent } = stage(writing(ASCII_PAYLOAD_PROBE, answer))
			expect(await runCheck(stringPayloadSurvives, ctx)).toEqual(outcome)
			expect(sent.filter((s) => s.method === "PATCH")).toHaveLength(1)
		}
		const model = modelOf(widgetDoc())
		const { ctx } = stage(
			writing(ASCII_PAYLOAD_PROBE, GATED),
			{},
			{
				updateOp: { ...op(model, "updateWidget"), featureGate: "beta" },
			},
		)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({
			kind: "stood-down",
			reason: "a documented feature gate refused the request",
		})
	})

	it("counts a write refused as absent, conflicting or unsupported as kept", async () => {
		for (const status of [404, 409, 415]) {
			const { ctx, findings } = stage(writing(GERMAN, { status }))
			expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
			expect(findings.findings).toEqual([])
		}
	})

	it("reports a valid string refused with a client or server error", async () => {
		const { ctx, findings } = stage(writing(GERMAN, { status: 422 }))
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain(`german (`)
		expect(findings.findings[0]?.detail).toContain(`got HTTP 422`)
		expect(findings.findings[0]?.detail).not.toContain("more.")
	})

	it("reports a 401 on one payload that an ordinary write right after does not get", async () => {
		const { ctx, findings } = stage(writing(GERMAN, { status: 401 }))
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("got HTTP 401")
	})
})

describe("payload.string-survives stops and narrowing", () => {
	it("stops when authentication is lost mid-catalog, and reports only what failed before", async () => {
		let lost = false
		const losing = (rows?: Rows, mangle = false): Responder => {
			const api = widgetApi(rows)
			return (method, path, options) => {
				if (method === "PATCH" && noteOf(options.body) === GERMAN) lost = true
				if (lost && method === "PATCH") return { status: 401 }
				if (mangle && method === "PATCH" && noteOf(options.body) === "") return { body: { note: null }, status: 200 }
				return api(method, path, options)
			}
		}
		const { ctx, sent } = stage(losing())
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({
			kind: "unresolved",
			reason: "authentication failed in the middle of the payload catalog, so remaining cases were not run",
		})
		expect(sent.filter((s) => s.method === "PATCH").length).toBeLessThan(STRING_PAYLOADS.length)
		lost = false
		const { ctx: failedFirst, findings } = stage(losing(undefined, true))
		expect(await runCheck(stringPayloadSurvives, failedFirst)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("empty (")
	})

	it("stands down when a payload write meets a feature gate or a rate limit", async () => {
		const model = modelOf(widgetDoc())
		const gatedOp = { ...op(model, "updateWidget"), featureGate: "beta" }
		const { ctx, findings } = stage(writing(GERMAN, GATED), {}, { updateOp: gatedOp })
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({
			kind: "stood-down",
			reason: "a documented feature gate refused the request",
		})
		expect(findings.byVerdict("COVERAGE_GAP")).toHaveLength(1)
		const { ctx: limited } = stage(writing(GERMAN, { status: 429 }))
		expect(await runCheck(stringPayloadSurvives, limited)).toEqual({
			kind: "stood-down",
			reason: "the request was rate limited",
		})
	})
})

describe("payload.string-survives on a write path the whole catalog already ran on", () => {
	it("sends one case of each family to a write path the whole catalog already ran on", async () => {
		/* A first entity runs the whole catalog on this path; the second gets the narrowed set. */
		const claims = new PayloadClaims()
		const payloads = { claims, policy: "per-write-path" as const }
		const { ctx: first, findings: firstFindings } = stage(widgetApi(), {}, { entityName: "gadget", payloads })
		const { ctx, findings, sent } = stage(widgetApi(), {}, { payloads })
		const writeOp = first.updateOp
		if (writeOp === undefined) throw new Error("the widget document has an update")
		const path = writePathOf(first, writeOp, "note")
		claims.plan([
			{ entity: "gadget", path },
			{ entity: ctx.entityName, path },
		])
		await runCheck(stringPayloadSurvives, first)
		expect(firstFindings.byVerdict("COVERAGE_GAP")).toEqual([])
		/* The path's coverage is whole: the narrowing is a note on the run, not a gap. */
		const outcome = await runCheck(stringPayloadSurvives, ctx)
		expect(outcome).toEqual({
			kind: "asserted",
			note: expect.stringMatching(/^\d+ of \d+ payload cases sent to "note"/),
		})
		expect(outcome.kind === "asserted" && outcome.note).toContain("on gadget")
		expect(findings.findings).toEqual([])
		expect(sent.filter((s) => s.method === "PATCH").length).toBeLessThanOrEqual(REQUIRED_IDS.length + 1)
	})

	it("runs the whole catalog itself when the entity before it stopped partway through", async () => {
		const claims = new PayloadClaims()
		const payloads = { claims, policy: "per-write-path" as const }
		const { ctx: first } = stage(writing(GERMAN, { status: 429 }), {}, { entityName: "gadget", payloads })
		const { ctx, findings, sent } = stage(widgetApi(), {}, { payloads })
		const writeOp = first.updateOp
		if (writeOp === undefined) throw new Error("the widget document has an update")
		const path = writePathOf(first, writeOp, "note")
		claims.plan([
			{ entity: "gadget", path },
			{ entity: ctx.entityName, path },
		])
		expect(await runCheck(stringPayloadSurvives, first)).toMatchObject({ kind: "stood-down" })
		/* The lane settles an entity once it is done; the first never ran the catalog to its end. */
		claims.settle("gadget")
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		const patched = sent.filter((s) => s.method === "PATCH").map((s) => noteOf(s.options.body))
		expect(new Set(patched.slice(1))).toEqual(new Set(STRING_PAYLOADS.map((payload) => payload.value)))
	})
})

describe("payload.string-survives lane records", () => {
	it("runs on the records it could make when later scratch records fail", async () => {
		let posts = 0
		const { ctx, sent } = stage(
			overriding(widgetApi(), (method) => (method === "POST" && ++posts > 2 ? { status: 500 } : undefined)),
		)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
		expect(new Set(sent.filter((s) => s.method === "PATCH").map((s) => s.path)).size).toBe(2)
		const { ctx: none } = stage(overriding(widgetApi(), (method) => (method === "POST" ? { status: 500 } : undefined)))
		expect(await runCheck(stringPayloadSurvives, none)).toEqual({
			kind: "unresolved",
			reason: "a record for this check could not be made: the create answered 500",
		})
	})

	it("writes a whole representation through a PUT update", async () => {
		const { ctx, findings, sent } = stage(widgetApi(), { update: "put" })
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.find((s) => s.method === "PUT")?.options.body).toMatchObject({ name: expect.any(String) })
	})
})

describe("payload.string-survives through create", () => {
	it("creates, reads back and removes one record per value", async () => {
		const { ctx, findings, sent } = stage(widgetApi(), CREATE_ONLY)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		const posts = sent.filter((s) => s.method === "POST").length
		expect(posts).toBe(STRING_PAYLOADS.length + 1)
		expect(sent.filter((s) => s.method === "DELETE")).toHaveLength(posts)
	})

	it("reports a create that fails with 5xx on non-ASCII, and leaves nothing to remove", async () => {
		const crashing = overriding(widgetApi(), (method, _, options) => {
			const note = noteOf(options.body)
			return method === "POST" &&
				typeof note === "string" &&
				[...note].some((char) => (char.codePointAt(0) ?? 0) > 0x7f)
				? { status: 500 }
				: undefined
		})
		const { ctx, findings, sent } = stage(crashing, CREATE_ONLY)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("got HTTP 500")
		const created = sent.filter((s) => s.method === "POST").length
		expect(sent.filter((s) => s.method === "DELETE").length).toBeLessThan(created)
	})

	it("removes a record a refused create made anyway", async () => {
		const { ctx, sent } = stage(writing(GERMAN, { body: { id: "kept-anyway" }, status: 422 }), CREATE_ONLY)
		expect((await runCheck(stringPayloadSurvives, ctx)).kind).toBe("finding")
		expect(sent.some((s) => s.method === "DELETE" && s.path === "/widgets/kept-anyway")).toBe(true)
		const { ctx: anonymous, sent: anonymousSent } = stage(writing(GERMAN, { body: {}, status: 422 }), CREATE_ONLY)
		expect((await runCheck(stringPayloadSurvives, anonymous)).kind).toBe("finding")
		expect(anonymousSent.filter((s) => s.method === "DELETE")).toHaveLength(STRING_PAYLOADS.length)
	})

	it("reports a create that succeeds without an identity to read back under", async () => {
		const { ctx, findings } = stage(writing(GERMAN, { body: {}, status: 201 }), CREATE_ONLY)
		expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("write succeeded but returned no identity")
	})

	it("is unresolved when the control create names no record", async () => {
		const reason = "the ASCII control write did not return an identity, so the value could not be read back"
		for (const answer of [{ body: {}, status: 201 }, { status: 302 }]) {
			const { ctx } = stage(writing(ASCII_PAYLOAD_PROBE, answer), CREATE_ONLY)
			expect(await runCheck(stringPayloadSurvives, ctx)).toEqual({ kind: "unresolved", reason })
		}
	})
})

describe("payload.string-survives plan", () => {
	it("needs a write, an item read, a create, and an update or delete", () => {
		expect(stringPayloadSurvives.plan(stage(widgetApi()).ctx).ok).toBe(true)
		expect(stringPayloadSurvives.plan(stage(widgetApi(), CREATE_ONLY).ctx).ok).toBe(true)
		expect(stringPayloadSurvives.plan(stage(widgetApi(), { read: false }).ctx).ok).toBe(false)
		expect(stringPayloadSurvives.plan({ ...stage(widgetApi()).ctx, createOp: undefined }).ok).toBe(false)
		expect(stringPayloadSurvives.plan(stage(widgetApi(), { remove: false, update: null }).ctx).ok).toBe(false)
		const { ctx } = stage(widgetApi(), {}, {})
		const noUpdateNoCreate = { ...ctx, createOp: undefined, updateOp: undefined as OperationModel | undefined }
		expect(stringPayloadSurvives.plan(noUpdateNoCreate).ok).toBe(false)
	})

	it("needs a writable string with nothing constraining it", () => {
		const item = {
			properties: { id: { readOnly: true, type: "string" }, kind: { enum: ["a"], type: "string" } },
			type: "object",
		}
		expect(stringPayloadSurvives.plan(stage(widgetApi(), { item }).ctx)).toEqual({
			needs: "a writable string field without a format or pattern to probe payloads against",
			ok: false,
		})
	})
})
