import { describe, expect, it } from "vitest"
import { type Answer, modelOf } from "../../__fixtures__/harness.ts"
import type { CheckContext } from "../../core/context.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext } from "./__fixtures__/context.ts"
import { nestedDocument, type Parent } from "./__fixtures__/nested.ts"
import type { NotesOptions } from "./__fixtures__/notes.ts"
import { foreignParentRejected } from "./tenant-parent-not-reachable-from-another-root.ts"

const BOOKS: Parent = { list: true, param: "book_id", segment: "books" }
const SCOPES = { altScope: { book_id: "b2", org_id: "o2" }, scope: { book_id: "b1", org_id: "o1" } }

/** Answers by `METHOD path`; anything else is a 404. */
const table = (answers: Record<string, Answer>) => (method: string, path: string) => answers[`${method} ${path}`]

/** How a stage departs from the default: the parents the notes nest under, the document's options, the context's fields. */
interface Setup {
	parents?: readonly Parent[]
	options?: NotesOptions & { prefix?: string }
	fields?: Partial<CheckContext>
}

function staged(answers: Record<string, Answer>, { parents = [BOOKS], options = {}, fields = {} }: Setup = {}) {
	return notesContext(modelOf(nestedDocument(parents, options)), table(answers), { ...SCOPES, ...fields })
}

/* The other tenant holds only its own book, b2. */
const OWN_BOOKS = { "GET /orgs/o2/books": { body: [{ id: "b2" }], status: 200 } }

describe("tenant.parent-not-reachable-from-another-root", () => {
	it("passes when the owner's parent is unknown under the other root", async () => {
		const { ctx, findings, sent } = staged(OWN_BOOKS)
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
		expect(
			sent.map((s) => `${s.method} ${s.path} ${(s.options.headers as Record<string, string>).authorization}`),
		).toEqual([
			"GET /orgs/o2/books other",
			"GET /orgs/o2/books/b1/notes other",
			"GET /orgs/o2/books/b1/notes/n1 other",
			"POST /orgs/o2/books/b1/notes other",
		])
		expect(findings.findings).toEqual([])
	})

	it("passes when the listing through the parent shows none of the owner's records", async () => {
		const { ctx, findings } = staged({
			...OWN_BOOKS,
			"GET /orgs/o2/books/b1/notes": { body: [{ id: "x" }], status: 200 },
		})
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY when a declared tenant's records are listed through the owner's parent", async () => {
		const { ctx, findings } = staged(
			{ ...OWN_BOOKS, "GET /orgs/o2/books/b1/notes": { body: [{ id: "n1" }], status: 200 } },
			{ options: { tenant: "org_id" } },
		)
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.summary).toBe(
			"another tenant's records are listed through their parent under one's own root",
		)
		expect(findings.findings[0]?.detail).toBe(
			"/orgs/{org_id}/books/{book_id}/notes with another tenant's book_id under its own org_id listed 1 record(s), including the owner's.",
		)
	})

	it("reports AMBIGUITY when the record is readable through the parent and the tenant was inferred", async () => {
		const { ctx, findings } = staged({ ...OWN_BOOKS, "GET /orgs/o2/books/b1/notes/n1": { status: 200 } })
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "finding", verdict: "AMBIGUITY" })
		expect(findings.findings[0]?.summary).toBe(
			"another tenant's record is readable through its parent under one's own root",
		)
		expect(findings.findings[0]?.detail).toContain('oat inferred the tenant from "org_id"')
	})
})

describe("tenant.parent-not-reachable-from-another-root: writes and skipped probes", () => {
	it("reports a child created under another tenant's parent", async () => {
		const { ctx, findings } = staged({ ...OWN_BOOKS, "POST /orgs/o2/books/b1/notes": { status: 201 } })
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "finding", verdict: "AMBIGUITY" })
		expect(findings.findings[0]?.summary).toBe("a child can be created under another tenant's parent")
	})

	it("skips the read without an item route or a record id, and the create without a body", async () => {
		for (const [options, fields] of [
			[{ bodilessCreate: true }, { readOp: undefined }],
			[{}, { createOp: undefined, records: [{ title: "first" }] }],
		] satisfies Array<[NotesOptions, Partial<CheckContext>]>) {
			const { ctx, sent } = staged(OWN_BOOKS, { options, fields })
			expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
			expect(sent.map((s) => s.method)).toEqual(["GET", "GET"])
		}
	})
})

describe("tenant.parent-not-reachable-from-another-root: the other tenant's own parents", () => {
	it("is unresolved when the other tenant holds a parent of its own by the same identity", async () => {
		const { ctx, sent } = staged({ "GET /orgs/o2/books": { body: [{ id: "b1" }], status: 200 } })
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({
			kind: "unresolved",
			reason: "the other tenant holds a book b1 of its own, so the owner's book_id under its root names that book",
		})
		expect(sent).toHaveLength(1)
	})

	it("keeps the first collision when every level below collides too", async () => {
		const PAGES: Parent = { list: true, param: "page_id", segment: "pages" }
		const { ctx } = staged(
			{
				"GET /orgs/o2/books": { body: [{ id: "b1" }], status: 200 },
				"GET /orgs/o2/books/b1/pages": { body: [{ id: "p1" }], status: 200 },
			},
			{
				parents: [BOOKS, PAGES],
				fields: {
					altScope: { book_id: "b2", org_id: "o2", page_id: "p2" },
					scope: { book_id: "b1", org_id: "o1", page_id: "p1" },
				},
			},
		)
		expect(await runCheck(foreignParentRejected, ctx)).toMatchObject({
			reason: expect.stringContaining("holds a book b1 of its own"),
		})
	})

	it("stops at the first level holding nothing named like the owner's", async () => {
		const PAGES: Parent = { list: true, param: "page_id", segment: "pages" }
		const { ctx, sent } = staged(
			{
				"GET /orgs/o2/books": { body: [{ id: "b1" }], status: 200 },
				"GET /orgs/o2/books/b1/pages": { body: [{ id: "p2" }], status: 200 },
			},
			{
				parents: [BOOKS, PAGES],
				fields: {
					altScope: { book_id: "b2", org_id: "o2", page_id: "p2" },
					scope: { book_id: "b1", org_id: "o1", page_id: "p1" },
				},
			},
		)
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
		expect(sent[1]?.path).toBe("/orgs/o2/books/b1/pages")
	})
})

describe("tenant.parent-not-reachable-from-another-root: parents it cannot rule out", () => {
	it("reads a parent with no identity of its own by id", async () => {
		const model = modelOf(nestedDocument([BOOKS]))
		const book = model.entities.get("book")
		if (book !== undefined) book.identity = null
		const answers = table({ "GET /orgs/o2/books": { body: [{ id: "b1" }], status: 200 } })
		const { ctx } = notesContext(model, answers, SCOPES)
		expect(await runCheck(foreignParentRejected, ctx)).toMatchObject({ kind: "unresolved" })
	})

	it("is unresolved when the other tenant's parents cannot be read whole", async () => {
		const { ctx } = staged({ "GET /orgs/o2/books": { status: 500 } })
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({
			kind: "unresolved",
			reason: "the other tenant's book list could not be read whole, so a book b1 of its own is not ruled out",
		})
	})
})

describe("tenant.parent-not-reachable-from-another-root: parents without a list", () => {
	it("reads the parent itself where it has no list, and cannot tell when it is served", async () => {
		const READ_ONLY: Parent = { param: "book_id", read: true, segment: "books" }
		const served = staged({ "GET /orgs/o2/books/b1": { status: 200 } }, { parents: [READ_ONLY] })
		expect(await runCheck(foreignParentRejected, served.ctx)).toEqual({
			kind: "unresolved",
			reason: "cannot tell whether the other tenant holds its own book b1",
		})
		expect(served.sent[0]?.options.operationId).toBe("read_book")
		const refused = staged({}, { parents: [READ_ONLY] })
		expect(await runCheck(foreignParentRejected, refused.ctx)).toEqual({ kind: "asserted" })
	})

	it("probes the boundary where the parent cannot be looked up under the other root", async () => {
		for (const [parent, prefix] of [
			[{ param: "book_id", read: true, readPath: "/shelves/{shelf_id}/books/{book_id}", segment: "books" }, undefined],
			[{ create: true, param: "book_id", segment: "books" }, undefined],
			[{ param: "book_id", segment: "books" }, undefined],
		] as const) {
			const { ctx, sent } = staged({}, { parents: [parent], options: prefix === undefined ? {} : { prefix } })
			expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
			expect(sent[0]?.path).toBe("/orgs/o2/books/b1/notes")
		}
	})

	it("probes the boundary where no entity owns the parent", async () => {
		const { ctx, sent } = staged(
			{},
			{
				parents: [],
				options: { prefix: "/{shelf_id}/orgs/{org_id}" },
				fields: {
					altScope: { org_id: "o2", shelf_id: "s2" },
					scope: { org_id: "o1", shelf_id: "s1" },
				},
			},
		)
		expect(await runCheck(foreignParentRejected, ctx)).toEqual({ kind: "asserted" })
		expect(sent[0]?.path).toBe("/s1/orgs/o2/notes")
	})
})

describe("tenant.parent-not-reachable-from-another-root planning", () => {
	it("stands down without a second tenant, a tenant, or a boundary of its own", () => {
		for (const [options, fields] of [
			[{}, { altAuth: undefined }],
			[{}, { altScope: undefined }],
			[{ tenant: false }, {}],
			[{}, { altScope: { book_id: "b2" } }],
			[{}, { altScope: { book_id: "b2", org_id: "o1" } }],
		] as const) {
			expect(foreignParentRejected.plan(staged({}, { options, fields }).ctx)).toEqual({ ok: false })
		}
	})

	it("names what is missing for a flat collection or a parent both tenants share", () => {
		expect(foreignParentRejected.plan(staged({}, { parents: [] }).ctx)).toEqual({
			needs: "a parent below the tenant in the collection's path",
			ok: false,
		})
		const shared = staged({}, { fields: { altScope: { book_id: "b1", org_id: "o2" } } })
		expect(foreignParentRejected.plan(shared.ctx)).toEqual({
			needs: "the other tenant's book_id has the same identity as the owner's",
			ok: false,
		})
	})

	it("grades the entity's list, read and create", () => {
		const model = modelOf(nestedDocument([BOOKS]))
		const entity = model.entities.get("note")
		expect(entity === undefined ? [] : foreignParentRejected.subjects(entity, model)).toEqual([
			"listNotes",
			"readNote",
			"createNote",
		])
	})
})
