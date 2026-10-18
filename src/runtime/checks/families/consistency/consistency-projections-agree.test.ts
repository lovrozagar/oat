import { describe, expect, it } from "vitest"
import type { CheckContext } from "../../core/context.ts"
import type { Record_ } from "../../../world.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { projectionsAgree } from "./consistency-projections-agree.ts"
import { notesBackend, notesDoc, servePage } from "./__fixtures__/notes.ts"

const rows = (): Record_[] => [
	{ id: "n1", status: "open", title: "alpha" },
	{ id: "n2", status: "done", title: "beta" },
]

/** A notes context whose first record is note n1, served by `respond`. */
function stage(respond: Responder, fields: Partial<CheckContext> = {}, doc = notesDoc()) {
	const model = modelOf(doc)
	const listOp = op(model, "notes.list")
	return contextFor(model, "notes.list", respond, {
		createOp: op(model, "notes.create"),
		query: listOp.query,
		readOp: op(model, "notes.get"),
		records: [{ id: "n1", status: "open", title: "alpha" }],
		...fields,
	})
}

/** Plans and runs the check, failing the test when the plan does not apply. */
async function drive(staged: ReturnType<typeof stage>) {
	const planned = projectionsAgree.plan(staged.ctx)
	if (!planned.ok) throw new Error(`the plan did not apply: ${planned.needs}`)
	return projectionsAgree.run(staged.ctx, planned.value)
}

const planWith = (fields: Partial<CheckContext>) => projectionsAgree.plan(stage(notesBackend(rows()), fields).ctx)

/** The correct backend, except where `override` answers first. */
const over =
	(store: Record_[], override: (path: string, query: Record<string, unknown>) => Answer | undefined): Responder =>
	(method, path, options) =>
		override(path, options.query ?? {}) ?? notesBackend(store)(method, path, options)

/** The collection read with neither a sort nor a sparse fieldset. */
const plainList = (path: string, query: Record<string, unknown>): boolean =>
	path === "/notes" && query.sort === undefined && query.fields === undefined

/** An item route serving `body` for note n1 beside an empty collection. */
const itemServes = (body: unknown): Responder =>
	over(rows(), (path) => {
		if (path === "/notes/n1") return { body, status: 200 }
		return path === "/notes" ? { body: [], status: 200 } : undefined
	})

/** A list endpoint taking a page size and `extra`, with `status` filterable and sortable. */
function narrowed(extra: string) {
	const doc = notesDoc({
		listParams: [
			{ in: "query", name: "limit", schema: { maximum: 5, type: "integer" } },
			{ in: "query", name: extra, schema: { type: "string" } },
		],
	})
	/* Too few parameters for the heuristic to derive capabilities; the full list's stand in. */
	const query = op(modelOf(notesDoc()), "notes.list").query
	if (query === null) throw new Error("the notes list lost its query capabilities")
	return stage(notesBackend(rows()), { query: { ...query, filterable: ["status"], sortable: ["status"] } }, doc)
}

describe("consistency.projections-agree plan", () => {
	it("needs a record and an item route", () => {
		expect(planWith({ records: [] }).ok).toBe(false)
		expect(planWith({ readOp: undefined }).ok).toBe(false)
	})

	it("picks the first filterable, sortable, client-owned field set to a scalar", () => {
		expect(planWith({})).toMatchObject({ ok: true, value: { field: "status", id: "n1" } })
	})

	it("skips generated, unsortable, null and object fields", () => {
		const model = modelOf(notesDoc())
		const base = op(model, "notes.list").query
		const generated = { ...op(model, "notes.create"), generated: ["status"] }
		expect(planWith({ createOp: generated })).toMatchObject({ value: { field: "title" } })
		expect(planWith({ createOp: undefined })).toMatchObject({ value: { field: "status" } })
		expect(planWith({ updateOp: generated })).toMatchObject({ value: { field: "title" } })
		expect(planWith({ query: base === null ? null : { ...base, sortable: ["id", "title"] } })).toMatchObject({
			value: { field: "title" },
		})
		expect(planWith({ records: [{ id: "n1", status: null, title: { text: "a" } }] })).toEqual({
			needs: "a client-owned field that is filterable, sortable and set on a record",
			ok: false,
		})
		expect(planWith({ query: null }).ok).toBe(false)
	})

	it("needs the record to carry its identity", () => {
		expect(planWith({ records: [{ status: "open" }] })).toEqual({
			needs: "a record that carries its identity",
			ok: false,
		})
	})
})

describe("consistency.projections-agree read paths", () => {
	it("asserts when every read path and the equality filter agree", async () => {
		const staged = stage(notesBackend(rows()))
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.findings.findings).toEqual([])
		const queries = staged.sent.map((sent) => [sent.path, sent.options.query ?? {}])
		expect(queries.slice(0, 5)).toEqual([
			["/notes/n1", {}],
			["/notes", { limit: 5 }],
			["/notes", { fields: "id,status", limit: 5 }],
			["/notes", { limit: 5, sort: "status.asc" }],
			["/notes", { limit: 5, page: 1, status: "open" }],
		])
		/* Whatever the walk reads past its first page is the same filter. */
		expect(queries.slice(5).every(([, query]) => (query as Record<string, unknown>).status === "open")).toBe(true)
	})

	it("is unresolved when the item route gives no reference value", async () => {
		const staged = stage(over(rows(), (path) => (path === "/notes/n1" ? { status: 500 } : undefined)))
		expect(await drive(staged)).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("returned 500") })
		expect(staged.sent).toHaveLength(1)
	})

	it("reports a collection that serves a different value than the item route", async () => {
		const stale = [{ id: "n1", status: "pending", title: "alpha" }]
		const staged = stage(
			over(rows(), (path, query) => (plainList(path, query) ? { body: stale, status: 200 } : undefined)),
		)
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("the same record carries different values depending on how it is read")
		expect(finding?.detail).toContain('the collection returns "pending"')
		expect(finding?.detail).not.toContain("sparse fieldset")
		expect(finding?.evidence.map((e) => e.url)).toEqual(["http://api.test/notes/n1", "http://api.test/notes"])
	})

	it("names every disagreeing projection", async () => {
		const staged = stage(
			over(rows(), (path, query) =>
				path === "/notes" && (query.sort !== undefined || query.fields !== undefined)
					? { body: [{ id: "n1", status: "stale" }], status: 200 }
					: undefined,
			),
		)
		await drive(staged)
		expect(staged.findings.findings[0]?.detail).toContain(
			'the sparse fieldset returns "stale", and the sorted page returns "stale"',
		)
	})
})

describe("consistency.projections-agree absent projections", () => {
	it("compares only projections the record appears on", async () => {
		const staged = stage(over(rows(), (path) => (path === "/notes" ? { body: [], status: 200 } : undefined)))
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("a record is missing from a filter matching its own field value")
	})

	it("reads only the collection where the endpoint has no fieldset or sort parameter", async () => {
		const staged = narrowed("status")
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query ?? {})).toEqual([
			{},
			{ limit: 5 },
			{ limit: 5, status: "open" },
		])
	})
})

describe("consistency.projections-agree filter membership", () => {
	it("is unresolved when the item route serves no value for the field", async () => {
		expect(await drive(stage(itemServes({ id: "n1", status: null })))).toEqual({
			kind: "unresolved",
			reason: '"status" is null on the item route, and equality is not defined for null',
		})
		expect(await drive(stage(itemServes({ id: "n1" })))).toMatchObject({ kind: "unresolved" })
		expect(await drive(stage(itemServes([])))).toMatchObject({ kind: "unresolved" })
	})

	it("stands down when the filter grammar cannot write an equality term", async () => {
		expect(await drive(narrowed("filter"))).toEqual({
			kind: "stood-down",
			reason: "the filter grammar cannot express this probe",
		})
	})

	it("is unresolved when the filter is refused", async () => {
		const staged = stage(
			over(rows(), (path, query) => (path === "/notes" && query.status !== undefined ? { status: 400 } : undefined)),
		)
		expect(await drive(staged)).toEqual({ kind: "unresolved", reason: 'filtering on "status" was rejected' })
	})

	it("does not call the record missing when the filtered walk could not finish", async () => {
		const other = { id: "x", status: "open", title: "x" }
		const staged = stage(
			over(rows(), (path, query) =>
				path === "/notes" && query.status !== undefined ? { body: [other], status: 200 } : undefined,
			),
		)
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "the filtered set is larger than the walk covers, so the record's absence is not established",
		})
	})

	it("reports a record its own field-value filter does not return", async () => {
		const staged = stage(
			over(rows(), (path, query) =>
				path === "/notes" && query.status !== undefined
					? { body: servePage(rows(), { ...query, status: "done" }), status: 200 }
					: undefined,
			),
		)
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.detail).toContain('note n1 carries "status" = "open" on every read path')
		expect(finding?.evidence).toHaveLength(2)
	})
})
