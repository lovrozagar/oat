import { describe, expect, it } from "vitest"
import type { Listed } from "../../core/context.ts"
import type { Record_ } from "../../../world/records.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { readAfterWrite } from "./list-read-after-write.ts"
import { FULL_LIST, notesBackend, notesDoc, servePage } from "./__fixtures__/notes.ts"

const created = { id: "n1", status: "open", title: "alpha" }
const others = (count: number): Record_[] =>
	Array.from({ length: count }, (_, index) => ({ id: `o${index}`, status: "open", title: `o${index}` }))

/** A notes context whose seeded record is `created`, served by `respond`. */
function stage(respond: Responder, fields: Partial<Listed> = {}, doc = notesDoc()) {
	const model = modelOf(doc)
	return contextFor(model, "notes.list", {
		respond,
		fields: {
			createOp: op(model, "notes.create"),
			readOp: op(model, "notes.get"),
			records: [created],
			...fields,
		},
	})
}

async function drive(staged: ReturnType<typeof stage>) {
	const planned = readAfterWrite.plan(staged.ctx)
	if (!planned.ok) throw new Error(`the plan did not apply: ${planned.needs}`)
	return readAfterWrite.run(staged.ctx, planned.value)
}

/** STALE_LIST: the item route serves the created record, the list a snapshot taken before it. */
function staleList(snapshot: Record_[], pageSizeShows?: number): Responder {
	return (method, path, options) => {
		if (path !== "/notes") return notesBackend([created, ...snapshot])(method, path, options)
		const query = options.query ?? {}
		const rows = Number(query["limit"]) === pageSizeShows ? [created, ...snapshot] : snapshot
		return { body: servePage(rows, query), status: 200 }
	}
}

/** STALE_LIST with an item route that does not serve the record either. */
const goneEverywhere: Responder = (method, path, options) =>
	path === "/notes/n1" ? undefined : staleList(others(1))(method, path, options)

/** STALE_LIST whose walk at a smaller page size is refused. */
const smallerRefused: Responder = (method, path, options) =>
	path === "/notes" && options.query?.["limit"] === 4 ? { status: 500 } : staleList(others(1))(method, path, options)

const listPaths = (staged: ReturnType<typeof stage>) => staged.sent.filter((sent) => sent.path === "/notes")

describe("list.read-after-write plan", () => {
	it("needs a create and a seeded record that carries its identity", () => {
		const needs = { needs: "a record that carries its identity", ok: false }
		expect(readAfterWrite.plan(stage(notesBackend([]), { createOp: undefined }).ctx)).toEqual(needs)
		expect(readAfterWrite.plan(stage(notesBackend([]), { records: [{ title: "x" }] }).ctx)).toEqual(needs)
		expect(readAfterWrite.plan(stage(notesBackend([])).ctx)).toEqual({ ok: true, value: { id: "n1" } })
	})
})

describe("list.read-after-write lost writes", () => {
	it("asserts when the list shows the created record, without reading the item route", async () => {
		const staged = stage(notesBackend([...others(7), created]))
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.sent.every((sent) => sent.path === "/notes")).toBe(true)
		/* Walked unsorted, at the largest documented page. */
		expect(staged.sent[0]?.options.query).toEqual({ limit: 5, page: 1 })
	})

	it("reports a list that never shows a record the item route serves", async () => {
		const staged = stage(staleList(others(2)))
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding).toMatchObject({
			detail:
				"created note n1 is served by the item route (200) but does not appear in the list route — the two projections disagree",
			summary: "list projection does not reflect a completed write",
		})
		expect(finding?.evidence.map((e) => e.url)).toEqual([
			expect.stringContaining("http://api.test/notes"),
			"http://api.test/notes/n1",
		])
		/* The repeat walks, then one at a smaller page size to move the page boundaries. */
		expect(listPaths(staged).some((sent) => sent.options.query?.["limit"] === 4)).toBe(true)
	})

	it("reports the record as absent when the item route does not serve it either", async () => {
		const staged = stage(goneEverywhere)
		await drive(staged)
		expect(staged.findings.findings[0]?.detail).toBe("created note n1 is absent from the list projection")
		expect(staged.findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("reports from the list alone when the entity has no item route", async () => {
		const staged = stage(staleList(others(1)), { readOp: undefined })
		await drive(staged)
		expect(staged.findings.findings[0]?.detail).toBe("created note n1 is absent from the list projection")
		expect(staged.findings.findings[0]?.evidence).toHaveLength(1)
		expect(staged.sent.some((sent) => sent.path === "/notes/n1")).toBe(false)
	})
})

describe("list.read-after-write page boundaries", () => {
	it("asserts when a walk at another page size finds the record: paging lost it, not the write", async () => {
		const staged = stage(staleList(others(6), 4))
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.findings.findings).toEqual([])
	})

	it("reports when the walk at another page size is refused", async () => {
		const staged = stage(smallerRefused)
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("has no other page size to try when the list pages one record at a time", async () => {
		const [limit, ...rest] = FULL_LIST
		const doc = notesDoc({ listParams: [{ ...limit, schema: { maximum: 1, type: "integer" } }, ...rest] })
		const staged = stage(staleList(others(1)), {}, doc)
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(listPaths(staged).every((sent) => sent.options.query?.["limit"] === 1)).toBe(true)
	})
})

describe("list.read-after-write unresolved walks", () => {
	it("is unresolved when the list is refused", async () => {
		const staged = stage(() => ({ status: 500 }))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "the list was rejected, so whether the write is visible cannot be decided",
		})
	})

	it("is unresolved when the walk could not read the list whole", async () => {
		const staged = stage((_, path) => (path === "/notes" ? { body: others(5), status: 200 } : undefined))
		expect(await drive(staged)).toEqual({
			kind: "unresolved",
			reason: "pages repeat the same records, so whether the write is visible cannot be decided",
		})
	})

	/*
	 * Bug: the two repeat walks call `collectSet` with the same request and no write between
	 * them, so `readSet`'s memo hands back the first walk instead of reading the list again. A
	 * record an unstable default order hid from one walk is then reported as a lost write.
	 */
	it("asserts when a repeat walk of the default listing finds the record", async () => {
		let walks = 0
		const respond: Responder = (method, path, options) => {
			if (path !== "/notes") return notesBackend([created])(method, path, options)
			/* Only the default-size walk counts and recovers; the smaller-page walk never shows it. */
			const repeat = options.query?.["limit"] === 5
			if (repeat && options.query?.["page"] === 1) walks += 1
			const rows = repeat && walks >= 2 ? [created] : []
			return { body: servePage(rows, options.query), status: 200 }
		}
		const staged = stage(respond, { readOp: undefined })
		expect(await drive(staged)).toEqual({ kind: "asserted" })
	})
})
