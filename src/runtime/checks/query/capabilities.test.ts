import { describe, expect, it } from "vitest"
import type { QueryCapability as QueryTag } from "../../../spec/extensions.ts"
import {
	asTermValue,
	canUseOp,
	conv,
	filterable,
	filterableNames,
	filterIdentity,
	identityIsFilterable,
	pageable,
	pageSize,
	q,
	resolvedCaps,
	schemaType,
} from "./capabilities.ts"
import { BARE, notesContext, withConventions } from "./__fixtures__/notes.ts"

/*
 * The query helpers every family builds its requests from. A check names roles — a page size, a
 * page, an order — and these spell them the way this endpoint's document does, never past its
 * documented maximum, and answer what the endpoint can express at all.
 */

const base = () => notesContext().ctx

describe("q", () => {
	it("spells every role the way the document names it", () => {
		const ctx = withConventions(base(), { cursor: "after", searchMode: "mode" })
		expect(
			q(ctx, { cursor: "c1", filter: "name=eq.a", limit: 2, order: "name.asc", page: 2, search: "x", searchMode: "k" }),
		).toEqual({ after: "c1", filter: "name=eq.a", limit: 2, mode: "k", page: 2, q: "x", sort: "name.asc" })
	})

	it("writes the parameters in one order, so the same roles make the same URL", () => {
		const ctx = withConventions(base(), { cursor: "after", searchMode: "mode" })
		const all = { cursor: "c", filter: "f", limit: 2, order: "name.asc", page: 2, search: "s", searchMode: "m" }
		expect(Object.keys(q(ctx, all))).toEqual(["limit", "page", "after", "sort", "q", "mode", "filter"])
	})

	it("never asks for more than the documented maximum", () => {
		expect(q(base(), { limit: 50 })).toEqual({ limit: 3 })
	})

	it("turns a page number into an offset where the endpoint skips rows instead", () => {
		const ctx = withConventions(base(), { offset: "skip", page: undefined })
		expect(q(ctx, { limit: 2, page: 3 })).toEqual({ limit: 2, skip: 4 })
		expect(q(ctx, { page: 0 })).toEqual({ skip: 0 })
		/* Without a stated size the walk assumes 20 a page, consistently. */
		expect(q(ctx, { page: 2 })).toEqual({ skip: 20 })
	})

	it("omits a role the endpoint has no parameter for", () => {
		const ctx = withConventions(base(), BARE)
		expect(
			q(ctx, { cursor: "c", filter: "f", limit: 2, order: "name.asc", page: 2, search: "s", searchMode: "m" }),
		).toEqual({})
		expect(q(base(), {})).toEqual({})
	})
})

describe("pageSize", () => {
	it("is the limit parameter's documented maximum, a declared max limit, or 100", () => {
		const ctx = base()
		expect(pageSize(ctx)).toBe(3)
		const query = ctx.listOp.query as QueryTag
		expect(pageSize({ ...ctx, listOp: { ...ctx.listOp, query: { ...query, maxLimit: 7 } } })).toBe(7)
		expect(pageSize(withConventions(ctx, { limit: undefined }))).toBe(100)
	})
})

describe("filterable", () => {
	it("holds where the endpoint has a filter parameter", () => {
		expect(filterable(base())).toBe(true)
	})

	it("holds for equality-per-field only when the document names filterable fields", () => {
		const ctx = withConventions(base(), { filter: undefined, grammar: "equality" })
		expect(filterable(ctx)).toBe(true)
		const query = ctx.query as QueryTag
		expect(filterable({ ...ctx, query: { ...query, filterable: [] } })).toBe(false)
		expect(filterable({ ...ctx, query: null })).toBe(false)
	})

	it("does not hold for a grammar that needs a parameter the endpoint lacks", () => {
		expect(filterable(withConventions(base(), { filter: undefined }))).toBe(false)
	})
})

describe("resolvedCaps", () => {
	it("is the context's own capabilities when the run resolved them", () => {
		const ctx = base()
		const capabilities = { ...resolvedCaps(ctx), identityFilter: "noteId" }
		expect(resolvedCaps({ ...ctx, capabilities })).toBe(capabilities)
	})

	it("merges the tag's declarations, optional ones included", () => {
		const ctx = base()
		const query = ctx.query as QueryTag
		const full: QueryTag = { ...query, defaultOrder: "rank.desc", stableTiebreak: "id" }
		const caps = resolvedCaps({ ...ctx, query: full })
		expect(caps.filterable.map((field) => field.field)).toEqual(["name", "rank"])
		expect(caps.sortable.map((field) => field.field)).toEqual(["name", "rank"])
		expect(caps.source).toBe("tag")
	})

	it("reads a bare tag, or none, from the item schema alone", () => {
		const ctx = base()
		const bare: QueryTag = { filterable: ["name"], searchable: [], selectable: [], sortable: [], source: "tag" }
		expect(filterableNames({ ...ctx, query: bare })).toEqual(["name"])
		expect(resolvedCaps({ ...ctx, query: null }).source).not.toBe("tag")
		expect(resolvedCaps({ ...ctx, listOp: { ...ctx.listOp, collection: null }, query: null }).filterable).toEqual([])
	})
})

describe("the identity as a filter", () => {
	it("is the declared identity filter, else the record's identity", () => {
		const ctx = base()
		expect(filterIdentity(ctx)).toBe("id")
		expect(filterIdentity({ ...ctx, capabilities: { ...resolvedCaps(ctx), identityFilter: "noteId" } })).toBe("noteId")
	})

	it("is filterable when either spelling is among the filterable fields", () => {
		const ctx = base()
		expect(identityIsFilterable(ctx)).toBe(false)
		const query = ctx.query as QueryTag
		expect(
			identityIsFilterable({ ...ctx, query: { ...query, filterable: ["id"], filterFields: [{ field: "id" }] } }),
		).toBe(true)
		const caps = resolvedCaps(ctx)
		const aliased = { ...caps, filterable: [...caps.filterable, { field: "noteId" }], identityFilter: "noteId" }
		expect(identityIsFilterable({ ...ctx, capabilities: aliased })).toBe(true)
	})
})

describe("canUseOp", () => {
	it("needs the grammar to write the operator and the field to allow it", () => {
		const ctx = base()
		const [name] = resolvedCaps(ctx).filterable
		if (name === undefined) throw new Error("the notes list filters by name")
		expect(canUseOp(ctx, name, "eq")).toBe(true)
		expect(canUseOp(withConventions(ctx, { filter: undefined, grammar: "equality" }), name, "neq")).toBe(false)
		expect(canUseOp(ctx, { ...name, ops: ["eq"] }, "gt")).toBe(false)
	})
})

describe("pageable", () => {
	it("holds by page number or by offset, and not without either", () => {
		expect(pageable(base())).toBe(true)
		expect(pageable(withConventions(base(), { offset: "skip", page: undefined }))).toBe(true)
		expect(pageable(withConventions(base(), BARE))).toBe(false)
	})
})

describe("asTermValue", () => {
	it("keeps numbers and writes everything else as text", () => {
		expect(asTermValue(3)).toBe(3)
		expect(asTermValue(true)).toBe("true")
		expect(asTermValue(null)).toBe("null")
	})
})

/** The notes context with its item schema holding only `properties`. */
function withItem(properties: Record<string, unknown>) {
	const ctx = base()
	const collection = ctx.listOp.collection
	if (collection === null) throw new Error("the notes list is a collection")
	return { ...ctx, listOp: { ...ctx.listOp, collection: { ...collection, itemSchema: { properties } } } }
}

describe("schemaType", () => {
	it("reads the item schema's type, looking through a nullable union", () => {
		const ctx = base()
		expect(schemaType(ctx, "rank")).toBe("integer")
		expect(schemaType(ctx, "tag")).toBe("string")
		expect(schemaType(ctx, "missing")).toBeUndefined()
		expect(schemaType(withItem({ a: { oneOf: [{ type: "null" }, { type: "number" }] } }), "a")).toBe("number")
		expect(schemaType(withItem({ a: { anyOf: [{ type: "boolean" }] } }), "a")).toBe("boolean")
	})

	it("is undefined when nothing names a type other than null", () => {
		expect(schemaType(withItem({ a: { type: ["null"] } }), "a")).toBeUndefined()
		expect(schemaType(withItem({ a: { type: "null" } }), "a")).toBeUndefined()
		expect(schemaType(withItem({ a: {} }), "a")).toBeUndefined()
		const ctx = base()
		expect(schemaType({ ...ctx, listOp: { ...ctx.listOp, collection: null } }, "rank")).toBeUndefined()
	})

	it("hands back the list operation's conventions", () => {
		const ctx = base()
		expect(conv(ctx)).toBe(ctx.listOp.conventions)
	})
})
