import { describe, expect, it } from "vitest"
import type { Record_ } from "../../world/records.ts"
import type { Listed } from "../core/context.ts"
import { resolvedCaps } from "./capabilities.ts"
import { compareScalars, holdsSomeNulls, nullableField, observeTextOrder, sortedUnder, tiedSortField } from "./order.ts"
import { notesContext } from "./__fixtures__/notes.ts"

/*
 * What oat may assume about a backend's order. It cannot know a collation, so an order is sorted
 * when it is sorted under one of the ways backends order text, and once the backend has shown —
 * or the document has declared — which, under that one alone; nulls sit together at one end.
 */

const withRecords = (records: Record_[]): Listed => notesContext(undefined, { records }).ctx

/** The notes context with the sort behaviour the document declares. */
function declaring(sort: { collation?: "binary" | "case-insensitive" | "locale"; defaultNulls?: "first" | "last" }) {
	const ctx = notesContext().ctx
	return { ...ctx, capabilities: { ...resolvedCaps(ctx), sort } }
}

describe("tiedSortField", () => {
	it("is the first sortable field whose values repeat, never the identity", () => {
		const records = [
			{ id: "1", name: "a", rank: 1 },
			{ id: "1", name: "b", rank: 1 },
		]
		expect(tiedSortField(withRecords(records))).toBe("rank")
	})

	it("is null when every sortable field is distinct, or nothing is sortable", () => {
		expect(
			tiedSortField(
				withRecords([
					{ id: "1", name: "a", rank: 1 },
					{ id: "2", name: "b", rank: 2 },
				]),
			),
		).toBeNull()
		expect(tiedSortField({ ...withRecords([{ name: "a" }, { name: "a" }]), query: null })).toBeNull()
	})

	it("passes over the identity even when it is sortable and repeats", () => {
		const ctx = withRecords([
			{ id: "1", name: "a" },
			{ id: "1", name: "b" },
		])
		const query = ctx.query
		if (query === null) throw new Error("the notes list declares its query")
		expect(tiedSortField({ ...ctx, query: { ...query, sortable: ["id", "name"] } })).toBeNull()
	})

	it("is read from the context it is given, never remembered across plans", () => {
		const ctx = withRecords([{ name: "a" }, { name: "a" }])
		expect(tiedSortField(ctx)).toBe("name")
		expect(
			tiedSortField({
				...ctx,
				records: [
					{ name: "a", rank: 1 },
					{ name: "b", rank: 2 },
				],
			}),
		).toBeNull()
		expect(tiedSortField({ ...ctx, query: ctx.query === null ? null : { ...ctx.query, sortable: [] } })).toBeNull()
	})
})

describe("nullableField and holdsSomeNulls", () => {
	const records = [
		{ id: "1", name: "a", tag: null },
		{ id: "2", name: "b", tag: "x" },
		{ id: "3", name: "c" },
	]

	it("finds a candidate null on some records and set on others", () => {
		const ctx = withRecords(records)
		expect(holdsSomeNulls(ctx, "tag")).toBe(true)
		expect(holdsSomeNulls(ctx, "name")).toBe(false)
		expect(holdsSomeNulls(ctx, "rank")).toBe(false)
		expect(nullableField(ctx, ["name", "tag"])).toBe("tag")
	})

	it("is null when no candidate qualifies, the identity included", () => {
		const ctx = withRecords([{ id: null }, { id: "2" }])
		expect(nullableField(ctx, ["id", "name"])).toBeNull()
	})
})

describe("compareScalars", () => {
	it("orders numbers numerically and everything else by its text", () => {
		expect(compareScalars(2, 10)).toBeLessThan(0)
		expect(compareScalars("2", "10")).toBeGreaterThan(0)
		expect(compareScalars("a", "b")).toBeLessThan(0)
		expect(compareScalars("a", "a")).toBe(0)
		expect(compareScalars(10, "9")).toBeLessThan(0)
	})
})

describe("sortedUnder", () => {
	it("accepts any of the text orders until one is known", () => {
		const ctx = notesContext().ctx
		expect(sortedUnder(ctx, "name", ["B", "a"])).toBe("binary")
		expect(sortedUnder(ctx, "name", ["a", "B"])).toBe("folded")
		expect(sortedUnder(ctx, "name", ["e", "é", "f"])).toBe("locale")
		expect(sortedUnder(ctx, "name", ["b", "a"])).toBeNull()
		expect(sortedUnder(ctx, "name", ["b", "A"])).toBeNull()
	})

	it("lets ties come in any order", () => {
		const ctx = notesContext().ctx
		expect(sortedUnder(ctx, "name", ["a", "a"])).toBe("binary")
		expect(sortedUnder(ctx, "name", ["a", "A"])).toBe("folded")
	})

	it("holds numbers to numeric order whatever the text order", () => {
		const ctx = notesContext().ctx
		expect(sortedUnder(ctx, "rank", [2, 10])).toBe("binary")
		expect(sortedUnder(ctx, "rank", [10, 2])).toBeNull()
	})

	it("needs the nulls together at one end", () => {
		const ctx = notesContext().ctx
		expect(sortedUnder(ctx, "tag", [null, "a", "b"])).toBe("binary")
		expect(sortedUnder(ctx, "tag", ["a", "b", undefined])).toBe("binary")
		expect(sortedUnder(ctx, "tag", ["a", null, "b"])).toBeNull()
		expect(sortedUnder(ctx, "tag", [null, null])).toBe("binary")
	})

	it("holds a field to the order and null placement the backend already showed", () => {
		const ctx = notesContext().ctx
		observeTextOrder(ctx, "name", "binary", [null, "B", "a"])
		expect(sortedUnder(ctx, "name", ["a", "B"])).toBeNull()
		expect(sortedUnder(ctx, "name", [null, "B", "a"])).toBe("binary")
		expect(sortedUnder(ctx, "name", ["B", "a", null])).toBeNull()
		observeTextOrder(ctx, "tag", "folded", ["a", null])
		expect(sortedUnder(ctx, "tag", [null, "a"])).toBeNull()
		expect(sortedUnder(ctx, "tag", ["a", "B", null])).toBe("folded")
	})

	it("holds a field to the collation the document declares", () => {
		expect(sortedUnder(declaring({ collation: "case-insensitive" }), "name", ["B", "a"])).toBeNull()
		expect(sortedUnder(declaring({ collation: "case-insensitive" }), "name", ["a", "B"])).toBe("folded")
		const ctx = declaring({ collation: "locale" })
		observeTextOrder(ctx, "name", "binary", ["B", "a"])
		expect(sortedUnder(ctx, "name", ["e", "é", "f"])).toBe("locale")
	})

	it("holds nulls to the end the document declares, with any text order until one is shown", () => {
		const ctx = declaring({ defaultNulls: "last" })
		expect(sortedUnder(ctx, "tag", [null, "a"])).toBeNull()
		expect(sortedUnder(ctx, "tag", ["a", "B", null])).toBe("folded")
		observeTextOrder(ctx, "tag", "binary", ["B", "a"])
		expect(sortedUnder(ctx, "tag", ["a", "B", null])).toBeNull()
		expect(sortedUnder(declaring({ defaultNulls: "first" }), "tag", ["a", null])).toBeNull()
	})
})

describe("observeTextOrder", () => {
	it("records the first order shown for a field and keeps it", () => {
		const ctx = notesContext().ctx
		observeTextOrder(ctx, "name", "folded", ["a", "B"])
		observeTextOrder(ctx, "name", "binary", ["B", "a"])
		expect(sortedUnder(ctx, "name", ["B", "a"])).toBeNull()
		expect(sortedUnder(ctx, "name", ["a", "B"])).toBe("folded")
	})

	it("records where nulls went only when the values held some of each", () => {
		const ctx = notesContext().ctx
		observeTextOrder(ctx, "a", "binary", [null, null])
		expect(sortedUnder(ctx, "a", ["x", null])).toBe("binary")
		observeTextOrder(ctx, "b", "binary", ["x", null])
		expect(sortedUnder(ctx, "b", [null, "x"])).toBeNull()
	})
})
