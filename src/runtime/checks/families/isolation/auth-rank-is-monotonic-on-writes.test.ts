import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../../../client/types.ts"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { rankIsMonotonicOnWrites } from "./auth-rank-is-monotonic-on-writes.ts"
import { notesBackend } from "./__fixtures__/backend.ts"
import { actor, caller, notesContext } from "./__fixtures__/context.ts"
import { type NotesOptions, notesDocument } from "./__fixtures__/notes.ts"

const HOME = { org_id: "o1" }
const owner = actor("owner", 2, HOME, { role: "owner" })
const viewer = actor("viewer", 0, HOME, { role: "viewer" })
const stranger = actor("stranger", 1, { org_id: "o2" })
const MEMBERS = { owner: "o1", stranger: "o2", viewer: "o1" }
const modelWith = (options: NotesOptions = {}) => modelOf(notesDocument(options))

/* Every create answers a note whose only string is empty: nothing an update could change. */
const blank = (method: string) => (method === "POST" ? { body: { id: "s1", title: "" }, status: 201 } : { status: 204 })

/** A backend where `allowed` says who may do what; the owner's own scratch creates always pass. */
const policy = (allowed: (who: string, kind: string) => boolean) =>
	notesBackend({ may: (who, kind) => allowed(who, kind), members: MEMBERS })

describe("auth.rank-is-monotonic-on-writes", () => {
	it("passes when the higher rank may write and the lower may not", async () => {
		const backend = policy((who) => who === "owner")
		const { ctx, findings, sent } = notesContext(modelWith(), backend, { actors: [owner, viewer, stranger] })
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => `${s.method} ${s.path} ${caller(s.options)}`)).toEqual([
			"POST /orgs/o1/notes owner",
			"POST /orgs/o1/notes owner",
			"PATCH /orgs/o1/notes/s2 owner",
			"POST /orgs/o1/notes owner",
			"DELETE /orgs/o1/notes/s3 owner",
			"POST /orgs/o1/notes viewer",
			"POST /orgs/o1/notes owner",
			"PATCH /orgs/o1/notes/s4 viewer",
			"POST /orgs/o1/notes owner",
			"DELETE /orgs/o1/notes/s5 viewer",
		])
		expect(findings.findings).toEqual([])
	})

	for (const kind of ["create", "update", "delete"]) {
		it(`reports a lower rank allowed to ${kind} where a higher rank is refused`, async () => {
			/* The owner's scratch creates stay allowed: only its own try at `kind` is refused. */
			const tries = new Map<string, number>()
			const backend = policy((who, asked) => {
				if (asked !== kind || who !== "owner") return true
				tries.set(who, (tries.get(who) ?? 0) + 1)
				return kind === "create" && (tries.get(who) ?? 0) > 1
			})
			const { ctx, findings } = notesContext(modelWith(), backend, { actors: [owner, viewer] })
			expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(findings.findings[0]?.summary).toBe(`a lower-ranked role can ${kind} where a higher-ranked role cannot`)
			expect(findings.findings[0]?.detail).toContain(`viewer (rank 0) was allowed to ${kind} note`)
			expect(findings.findings[0]?.detail).toContain("owner (rank 2) was refused (403)")
		})
	}

	it("names principals without a role by id, and counts a 401 as a refusal", async () => {
		const lead = actor("lead", 2, HOME)
		const member = actor("member", 1, HOME)
		const backend = notesBackend({ members: { ...MEMBERS, lead: "o1", member: "o1" } })
		const refusing = (method: string, path: string, options: RequestOptions) =>
			caller(options) === "lead" && method === "DELETE" ? { status: 401 } : backend(method, path, options)
		const { ctx, findings } = notesContext(modelWith({ without: ["updateNote"] }), refusing, {
			actors: [lead, member],
		})
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("member (rank 1) was allowed to delete note (204)")
		expect(findings.findings[0]?.detail).toContain("lead (rank 2) was refused (401)")
	})
})

describe("auth.rank-is-monotonic-on-writes without a verdict to compare", () => {
	it("does not read a write that failed for another reason as a refusal", async () => {
		const backend = policy(() => true)
		const failing = (method: string, path: string, options: RequestOptions) =>
			caller(options) === "owner" && method === "PATCH" ? { status: 500 } : backend(method, path, options)
		const { ctx, findings } = notesContext(modelWith(), failing, { actors: [owner, viewer] })
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("hands back what a failed scratch create concluded, before an update or a delete", async () => {
		for (const without of [[], ["updateNote"]] as const) {
			const backend = policy(() => true)
			const failing = (method: string, path: string, options: RequestOptions) =>
				method === "POST" && caller(options) === "owner" ? { status: 500 } : backend(method, path, options)
			const { ctx, sent } = notesContext(modelWith({ without }), failing, { actors: [owner, viewer] })
			expect((await runCheck(rankIsMonotonicOnWrites, ctx)).kind).toBe("unresolved")
			expect(sent.map((s) => s.method)).toEqual(["POST", "POST"])
		}
	})

	it("tries no create when the create takes no body, and stands down with no record to change", async () => {
		const { ctx, sent } = notesContext(
			modelWith({ bodilessCreate: true }),
			policy(() => true),
			{
				actors: [owner, viewer],
			},
		)
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({
			kind: "stood-down",
			reason: "a create operation with a request body, to make a record this check may change",
		})
		expect(sent).toEqual([])
	})
})

describe("auth.rank-is-monotonic-on-writes with nothing to try", () => {
	it("passes having tried nothing when no write can be compared", async () => {
		const { ctx, sent } = notesContext(
			modelWith({ bodilessCreate: true, without: ["updateNote", "deleteNote"] }),
			policy(() => true),
			{ actors: [owner, viewer] },
		)
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "asserted" })
		expect(sent).toEqual([])
	})

	it("tries no update when the scratch record has no field to change", async () => {
		const { ctx, sent } = notesContext(modelWith({ without: ["deleteNote"] }), blank, { actors: [owner, viewer] })
		expect(await runCheck(rankIsMonotonicOnWrites, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "POST", "POST"])
	})

	it("stands down without principals, a create, or two ranks in one tenant", () => {
		const backend = policy(() => true)
		for (const fields of [
			{ actors: [] },
			{ actors: [owner, viewer], createOp: undefined },
			{ actors: [owner, stranger] },
		]) {
			expect(rankIsMonotonicOnWrites.plan(notesContext(modelWith(), backend, fields).ctx)).toEqual({ ok: false })
		}
	})

	it("grades the entity's create, update and delete", () => {
		const model = modelWith()
		const entity = model.entities.get("note")
		expect(entity === undefined ? [] : rankIsMonotonicOnWrites.subjects(entity, model)).toEqual([
			"createNote",
			"updateNote",
			"deleteNote",
		])
	})
})
