import { describe, expect, it } from "vitest"
import type { Responder } from "../__fixtures__/harness.ts"
import { notesContext, withConventions } from "../query/__fixtures__/notes.ts"
import type { Record_ } from "../../world/records.ts"
import {
	collectSet,
	duplicates,
	listAgain,
	listAll,
	membership,
	readSettled,
	sameSet,
	setOf,
	settlePair,
} from "./compare.ts"
import { rows, served } from "./__fixtures__/serve.ts"

/*
 * Set reads shaped for the checks that compare them. Two reads that should agree and do not are
 * read again: when a read now holds other rows the collection is moving under the check, which
 * is no defect; only a disagreement the fresh reads repeat is the backend's.
 */

/** Rows by the `filter` term each request carries; `pick` may change them between reads. */
const byFilter =
	(pick: () => Record<string, Record_[]>): Responder =>
	(method, path, options) =>
		served(pick()[String(options.query?.["filter"])] ?? [])(method, path, options)

type Requests = Array<{ options: { query?: Record<string, unknown> } }>

const pageQuery = (sent: Requests, index: number) => sent[index]?.options.query

/** The requests that began a walk: one per set read. */
const walks = (sent: Requests) => sent.filter((request) => request.options.query?.["page"] === 1)

describe("listAll", () => {
	it("reads the whole set with the query's order and filters, dropping its paging", async () => {
		const { ctx, sent } = notesContext(served(rows(2)))
		const all = await listAll(ctx, { filter: "x", limit: 2, page: 3, sort: "name.desc" })
		expect(all).toMatchObject({ complete: true, items: rows(2) })
		expect(all.exchange).toBe(all.exchange)
		expect(pageQuery(sent, 0)).toEqual({ filter: "x", limit: 3, page: 1, sort: "name.desc" })
	})

	it("drops offset and cursor parameters too, and an order given as undefined", async () => {
		const { ctx, sent } = notesContext(served([]))
		const paged = withConventions(ctx, { cursor: "cursor", offset: "offset" })
		await listAll(paged, { cursor: "c", offset: 4, sort: undefined })
		expect(pageQuery(sent, 0)).toEqual({ limit: 3, page: 1 })
	})

	it("is incomplete when a page was refused, keeping the last page's envelope", async () => {
		const { ctx } = notesContext(() => ({ body: { error: "no" }, status: 500 }))
		expect(await listAll(ctx, {})).toMatchObject({ complete: false, envelope: { error: "no" }, items: [] })
	})

	it("shares a read of the same set", async () => {
		const { ctx, sent } = notesContext(served([]))
		await listAll(ctx, {})
		await listAll(ctx, {})
		expect(sent).toHaveLength(1)
	})
})

describe("listAgain", () => {
	it("reads the set again rather than sharing an earlier read", async () => {
		const { ctx, sent } = notesContext(served(rows(2)))
		await listAll(ctx, {})
		expect(await listAgain(ctx, {})).toMatchObject({ complete: true, items: rows(2) })
		expect(walks(sent)).toHaveLength(2)
	})

	it("is null when a page was refused, never rows vanishing", async () => {
		const { ctx } = notesContext(() => ({ status: 403 }))
		expect(await listAgain(ctx, {})).toBeNull()
	})
})

describe("collectSet", () => {
	it("reads the set at the requested size and order", async () => {
		const { ctx, sent } = notesContext(served(rows(1)))
		const read = await collectSet(ctx, 2, { filter: "x" }, { order: "name.asc" })
		expect(read?.items).toEqual(rows(1))
		expect(pageQuery(sent, 0)).toEqual({ filter: "x", limit: 2, page: 1, sort: "name.asc" })
		await collectSet(ctx, 2, { filter: "x" }, { order: "name.asc", fresh: true })
		expect(walks(sent)).toEqual([sent[0], sent[0]])
	})

	it("is null when a page was refused, never an empty set", async () => {
		const { ctx } = notesContext(() => ({ status: 403 }))
		expect(await collectSet(ctx, 3)).toBeNull()
	})
})

describe("membership", () => {
	it("is the sorted identities, whatever order the rows came in", () => {
		expect(membership([{ id: "b" }, { id: "a" }, { name: "x" }], "id")).toBe("a,b")
	})
})

/** A read again that must not happen. */
async function never(): Promise<never> {
	throw new Error("this read is not made again")
}

describe("settlePair", () => {
	const a = { items: [{ id: "1" }] }
	const b = { items: [{ id: "2" }] }

	it("keeps two reads that agree", async () => {
		expect(
			await settlePair("id", { first: a, second: { items: [{ id: "1" }] } }, { first: never, second: never }),
		).toEqual({
			first: a,
			second: { items: [{ id: "1" }] },
		})
	})

	it("is moving when the first read now holds other rows", async () => {
		expect(await settlePair("id", { first: a, second: b }, { first: async () => b, second: never })).toBe("moving")
	})

	it("is moving when the second read now holds other rows", async () => {
		expect(await settlePair("id", { first: a, second: b }, { first: async () => a, second: async () => a })).toBe(
			"moving",
		)
	})

	it("hands back the fresh pair when the disagreement holds still", async () => {
		const freshA = { items: [{ id: "1" }] }
		const freshB = { items: [{ id: "2" }] }
		const settled = await settlePair(
			"id",
			{ first: a, second: b },
			{ first: async () => freshA, second: async () => freshB },
		)
		expect(settled).toEqual({ first: freshA, second: freshB })
		expect(settled === "moving" || settled === null ? null : settled.first).toBe(freshA)
	})

	it("is null when either read again was refused", async () => {
		expect(await settlePair("id", { first: a, second: b }, { first: async () => null, second: never })).toBeNull()
		expect(
			await settlePair("id", { first: a, second: b }, { first: async () => a, second: async () => null }),
		).toBeNull()
	})
})

const TERMS = [{ filter: "a" }, { filter: "b" }]
const SETS = { a: rows(1), b: rows(2) }

/** Refuses the `b` term and serves the rest. */
const refusing: Responder = (method, path, options) =>
	options.query?.["filter"] === "b" ? { status: 400 } : byFilter(() => SETS)(method, path, options)

describe("readSettled", () => {
	it("hands back the reads when they agree, read once", async () => {
		const { ctx, sent } = notesContext(byFilter(() => SETS))
		const reads = await readSettled(ctx, TERMS, () => true)
		expect(reads).toHaveLength(2)
		expect(walks(sent)).toHaveLength(2)
	})

	it("hands back fresh reads when a disagreement survives them", async () => {
		const { ctx, sent } = notesContext(byFilter(() => SETS))
		const reads = await readSettled(ctx, TERMS, () => false)
		expect(Array.isArray(reads) ? reads.map((set) => set.items.length) : reads).toEqual([1, 2])
		expect(walks(sent)).toHaveLength(4)
	})

	it("is moving when a read now holds other rows", async () => {
		let sets: Record<string, Record_[]> = SETS
		const { ctx } = notesContext(byFilter(() => sets))
		const settled = await readSettled(ctx, TERMS, () => {
			sets = { ...SETS, b: rows(3).slice(0, 2).concat({ id: "late" }) }
			return false
		})
		expect(settled).toBe("moving")
	})

	it("is rejected when a term's read is refused, the first time or the second", async () => {
		expect(await readSettled(notesContext(refusing).ctx, TERMS, () => true)).toBe("rejected")
		let refuse = false
		const later: Responder = (method, path, options) =>
			(refuse ? refusing : byFilter(() => SETS))(method, path, options)
		const settled = await readSettled(notesContext(later).ctx, TERMS, () => {
			refuse = true
			return false
		})
		expect(settled).toBe("rejected")
	})

	it("is incomplete when a read could not show its set ended", async () => {
		const { ctx } = notesContext(() => ({ body: rows(3), status: 200 }))
		expect(await readSettled(ctx, TERMS, () => true)).toBe("incomplete")
	})
})

describe("set helpers", () => {
	it("lists each value seen more than once, once", () => {
		expect(duplicates(["a", "b", "a", "a", "c", "b"])).toEqual(["a", "b"])
		expect(duplicates(["a"])).toEqual([])
	})

	it("compares identity sets by members alone", () => {
		expect(setOf([{ id: "1" }, { id: "1" }, { id: 2 }], "id")).toEqual(new Set(["1", "2"]))
		expect(sameSet(new Set(["1", "2"]), new Set(["2", "1"]))).toBe(true)
		expect(sameSet(new Set(["1"]), new Set(["1", "2"]))).toBe(false)
		expect(sameSet(new Set(["1", "3"]), new Set(["1", "2"]))).toBe(false)
	})
})
