import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Listed } from "../../core/context.ts"
import type { Record_ } from "../../../world/records.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { declaredInvalidationHappens } from "./invalidation-declared-route-changes.ts"
import { notesBackend, notesDoc } from "./__fixtures__/notes.ts"

const FOREIGN = ["GET /boards", "GET /stats"]

const declaring = (invalidate: readonly string[]) => notesDoc({ invalidate })

/** A note context over `doc`, whose create declares FOREIGN unless the document says otherwise. */
function stage(respond: Responder, fields: Partial<Listed> = {}, doc = declaring(FOREIGN)) {
	const model = modelOf(doc)
	return contextFor(model, "notes.list", { respond, fields: { createOp: op(model, "notes.create"), ...fields } })
}

async function drive(staged: ReturnType<typeof stage>) {
	const planned = declaredInvalidationHappens.plan(staged.ctx)
	if (!planned.ok) throw new Error(`the plan did not apply: ${planned.needs}`)
	return declaredInvalidationHappens.run(staged.ctx, planned.value)
}

/**
 * A backend whose board listing and stats derive from the notes, unless `stale` freezes one of
 * them at its first answer (PARENT_PROJECTION_STALE), and `override` answers first.
 */
function derived(
	options: { stale?: "/boards" | "/stats"; override?: (method: string, path: string) => Answer | undefined } = {},
): Responder {
	const notes: Record_[] = []
	const frozen = new Map<string, Answer>()
	const live = (path: string): Answer =>
		path === "/boards"
			? { body: [{ count: notes.length, id: "b1" }], status: 200 }
			: { body: { count: notes.length, id: "s" }, status: 200 }
	return (method, path, options_) => {
		const scripted = options.override?.(method, path)
		if (scripted !== undefined) return scripted
		if (method !== "GET" || (path !== "/boards" && path !== "/stats")) {
			return notesBackend(notes)(method, path, options_)
		}
		if (path !== options.stale) return live(path)
		const first = frozen.get(path) ?? live(path)
		frozen.set(path, first)
		return first
	}
}

/** Graders that keep only one operation in scope. */
const grades =
	(operationId: string) =>
	(target: OperationModel): boolean =>
		target.operationId === operationId

/** Every declared route refused; the notes themselves answer. */
const refuseDeclared = (_: string, path: string): Answer | undefined =>
	path === "/notes" ? undefined : { status: 500 }

const routes = (ops: readonly OperationModel[]) => ops.map((o) => o.route)

describe("invalidation.declared-route-changes plan", () => {
	it("needs a create", () => {
		expect(declaredInvalidationHappens.plan(stage(derived(), { createOp: undefined }).ctx)).toEqual({ ok: false })
	})

	it("probes only other entities' read routes the document has", () => {
		const invalidate = ["GET /missing", "GET /notes", "POST /boards", ...FOREIGN, "GET /orgs/{org_id}/summary"]
		const planned = declaredInvalidationHappens.plan(stage(derived(), {}, declaring(invalidate)).ctx)
		if (!planned.ok) throw new Error("the plan did not apply")
		expect(routes(planned.value.foreign)).toEqual([...FOREIGN, "GET /orgs/{org_id}/summary"])
		expect(planned.value.schema).toMatchObject({ type: "object" })
	})

	it("does not apply when no foreign read route is declared", () => {
		expect(declaredInvalidationHappens.plan(stage(derived(), {}, declaring(["GET /notes"])).ctx)).toEqual({ ok: false })
	})

	it("probes an ungraded route only when the create is graded", () => {
		const planned = declaredInvalidationHappens.plan(stage(derived(), { inScope: grades("stats.get") }).ctx)
		expect(planned.ok && routes(planned.value.foreign)).toEqual(["GET /stats"])
		const none = declaredInvalidationHappens.plan(stage(derived(), { inScope: () => false }).ctx)
		expect(none).toEqual({ ok: false })
	})

	it("needs a create that takes a body", () => {
		expect(
			declaredInvalidationHappens.plan(stage(derived(), {}, notesDoc({ createBody: false, invalidate: FOREIGN })).ctx),
		).toEqual({
			needs: "a create operation with a request body",
			ok: false,
		})
	})

	it("judges the create and the foreign reads", () => {
		const model = modelOf(notesDoc({ invalidate: FOREIGN }))
		const note = model.entities.get("note")
		if (note === undefined) throw new Error("the document lost the note entity")
		expect(declaredInvalidationHappens.subjects(note, model)).toEqual(["notes.create", "boards.list", "stats.get"])
	})
})

describe("invalidation.declared-route-changes stale routes", () => {
	it("asserts when every declared route changes with the write", async () => {
		const staged = stage(derived())
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
			"GET /boards",
			"GET /stats",
			"POST /notes",
			"GET /boards",
			"GET /stats",
		])
	})

	it("reports a declared route that serves the same body after the write", async () => {
		const staged = stage(derived({ stale: "/stats" }))
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding).toMatchObject({
			operations: ["notes.create", "stats.get"],
			summary: "a route the document says is invalidated by this write did not change",
		})
		expect(finding?.detail).toContain('declares x-invalidate on "GET /stats"')
		expect(finding?.evidence.map((e) => `${e.method} ${e.url}`)).toEqual([
			"POST http://api.test/notes",
			"GET http://api.test/stats",
		])
	})

	it("reports a stale collection read whole, attributed only to what is graded", async () => {
		const staged = stage(derived({ stale: "/boards" }), { inScope: grades("notes.create") })
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({ operations: ["notes.create"] })
		const onlyStats = stage(derived({ stale: "/stats" }), { inScope: grades("stats.get") })
		await drive(onlyStats)
		expect(onlyStats.findings.findings[0]).toMatchObject({ operations: ["stats.get"] })
	})
})

describe("invalidation.declared-route-changes unreadable routes", () => {
	it("is unresolved when no declared route can be filled from this entity's scope", async () => {
		const staged = stage(derived(), {}, declaring(["GET /orgs/{org_id}/summary"]))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "the declared routes need identifiers outside this entity's scope, so they cannot be read",
		})
		expect(staged.sent).toEqual([])
	})

	it("skips a declared route needing an identifier outside the scope and judges the rest", async () => {
		const staged = stage(derived({ stale: "/stats" }), {}, declaring(["GET /orgs/{org_id}/summary", "GET /stats"]))
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("is unresolved when no declared route can be read before the write", async () => {
		const staged = stage(derived({ override: refuseDeclared }))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "none of the declared routes could be read before the write",
		})
		expect(staged.sent.some((sent) => sent.method === "POST")).toBe(false)
	})

	it("judges only routes it read on both sides of the write", async () => {
		let stats = 0
		const flaky = (method: string, path: string): Answer | undefined => {
			if (path === "/boards" && method === "GET") return { body: [{ id: "b1" }], status: 503 }
			if (path === "/stats") stats += 1
			return path === "/stats" && stats === 2 ? { status: 500 } : undefined
		}
		const staged = stage(derived({ override: flaky }))
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.sent.filter((sent) => sent.path === "/boards")).toHaveLength(1)
	})

	it("does not snapshot a collection it cannot read whole", async () => {
		const many = Array.from({ length: 500 }, (_, index) => ({ id: `b${index}` }))
		const huge = (method: string, path: string) =>
			method === "GET" && path === "/boards" ? { body: many, status: 200 } : undefined
		const staged = stage(derived({ override: huge, stale: "/stats" }), {}, declaring(["GET /boards"]))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "none of the declared routes could be read before the write",
		})
	})
})

describe("invalidation.declared-route-changes create", () => {
	it("is unresolved when the create fails", async () => {
		const staged = stage(derived({ override: (method) => (method === "POST" ? { status: 500 } : undefined) }))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "the create returned 500, so nothing was invalidated",
		})
	})

	it("says why when every client-chosen identity the create drew was refused with 409", async () => {
		const refusing = derived({ override: (method) => (method === "POST" ? { status: 409 } : undefined) })
		const staged = stage(refusing, { takenIdentities: new Set() })
		const outcome = await drive(staged)
		expect(outcome).toMatchObject({ kind: "unresolved" })
		expect((outcome as { reason: string }).reason).toMatch(
			/^every client-chosen "id" sent was refused with 409 \(.+\); no fourth create was sent, so nothing was invalidated$/,
		)
		expect(staged.sent.filter((request) => request.method === "POST")).toHaveLength(3)
	})

	it("stands down on a documented feature gate", async () => {
		const gate = { body: { vars: { type: "feature_gate" } }, status: 403 }
		const staged = stage(derived({ override: (method) => (method === "POST" ? gate : undefined) }))
		const gated = { ...op(staged.ctx.model, "notes.create"), featureGate: "notes" }
		const ctx = { ...staged.ctx, createOp: gated }
		const planned = declaredInvalidationHappens.plan(ctx)
		if (!planned.ok) throw new Error("the plan did not apply")
		expect(await declaredInvalidationHappens.run(ctx, planned.value)).toEqual({
			kind: "stood-down",
			reason: "a documented feature gate refused the request",
		})
		expect(staged.findings.findings[0]).toMatchObject({ verdict: "COVERAGE_GAP" })
	})
})

describe("invalidation.declared-route-changes as a principal a higher rank outranks", () => {
	it("stands down without sending a create whose body requires a property only the highest rank sets", async () => {
		const staged = stage(derived())
		const low = { ...staged.ctx.actor, id: "low", rank: 0 }
		const createOp = { ...(staged.ctx.createOp as OperationModel), privilegedRequired: ["title"] }
		const outranked = {
			...staged,
			ctx: { ...staged.ctx, actor: low, actors: [{ ...low, id: "top", rank: 2 }, low], createOp },
		}
		expect(await drive(outranked)).toEqual({
			kind: "stood-down",
			reason:
				"notes.create requires title, marked x-privileged, which only top (rank 2) may set; low (rank 0) does not send it",
		})
		expect(staged.sent.map((sent) => sent.method)).toEqual(["GET", "GET"])
	})
})
