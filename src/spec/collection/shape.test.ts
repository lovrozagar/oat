import { describe, expect, it } from "vitest"
import type { JsonSchema } from "../types.ts"
import { ambiguousRows, deriveCollectionShape, rowsOf } from "./shape.ts"

const item = { properties: { id: { type: "string" } }, type: "object" }
const list = (items: unknown = item) => ({ items, type: "array" })

describe("deriveCollectionShape", () => {
	it("reads a bare array", () => {
		expect(deriveCollectionShape(list())).toEqual({
			envelopeKeys: [],
			itemSchema: item,
			key: null,
			pagination: {},
			within: [],
		})
		expect(deriveCollectionShape({ type: "array" })?.itemSchema).toBeNull()
		expect(deriveCollectionShape({ anyOf: [list(), { type: "null" }] })?.key).toBeNull()
	})

	it("does not read a document with an array field as a list", () => {
		const document = {
			properties: {
				components: { properties: { schemas: { type: "object" } }, type: "object" },
				info: { properties: { title: { type: "string" } }, type: "object" },
				openapi: { type: "string" },
				paths: { additionalProperties: { type: "object" }, type: "object" },
				servers: { items: { properties: { url: { type: "string" } }, type: "object" }, type: "array" },
			},
			type: "object",
		} as JsonSchema
		expect(deriveCollectionShape(document)).toBeNull()
		expect(
			deriveCollectionShape({ properties: { config: { additionalProperties: {} }, rows: list() }, type: "object" }),
		).toBeNull()
	})
})

describe("deriveCollectionShape: envelopes", () => {
	it("reads a paged envelope and its pagination keys", () => {
		const envelope = {
			properties: {
				has_more: { type: "boolean" },
				items: list(),
				next_cursor: { type: "string" },
				page_size: { type: "integer" },
				pageNumber: { type: "integer" },
				total: { type: "integer" },
			},
			type: "object",
		} as JsonSchema
		expect(deriveCollectionShape(envelope)).toEqual({
			envelopeKeys: ["has_more", "next_cursor", "page_size", "pageNumber", "total"],
			itemSchema: item,
			key: "items",
			pagination: {
				countKey: "total",
				cursorKey: "next_cursor",
				hasMoreKey: "has_more",
				limitKey: "page_size",
				pageKey: "pageNumber",
			},
			within: [],
		})
	})

	it("still reads an envelope with a meta or links sidecar", () => {
		const envelope = {
			properties: {
				data: list(),
				errors: list({ type: "object" }),
				links: { properties: { next: { type: "string" } }, type: "object" },
				meta: { properties: { total: { type: "integer" } }, type: "object" },
			},
			type: "object",
		} as JsonSchema
		expect(deriveCollectionShape(envelope)?.key).toBe("data")
	})
})

describe("deriveCollectionShape: choosing the rows", () => {
	it("takes the array of objects over an array of scalars, and a scalar array when that is all", () => {
		expect(deriveCollectionShape({ properties: { ids: list({ type: "string" }), rows: list() } })?.key).toBe("rows")
		expect(deriveCollectionShape({ properties: { ids: list({ type: "string" }) } })?.key).toBe("ids")
	})

	it("leaves two arrays of objects unnamed unless recordPath names one", () => {
		const two = { properties: { fields: list(), rows: list() }, type: "object" }
		expect(deriveCollectionShape(two)).toBeNull()
		expect(deriveCollectionShape(two, "$.rows")?.key).toBe("rows")
		expect(deriveCollectionShape(two, "$.rows[*]")?.key).toBe("rows")
		expect(deriveCollectionShape(two, "$.nope")).toBeNull()
		expect(deriveCollectionShape(two, null)).toBeNull()
	})

	it("is null without a schema, properties, or a usable array", () => {
		expect(deriveCollectionShape(null)).toBeNull()
		expect(deriveCollectionShape({ type: "object" })).toBeNull()
		expect(deriveCollectionShape({ properties: null })).toBeNull()
		expect(deriveCollectionShape({ properties: { name: { type: "string" }, odd: null, flag: true } })).toBeNull()
		expect(deriveCollectionShape({ properties: { rows: list(null) } })).toBeNull()
		expect(deriveCollectionShape({ properties: { errors: list() } })).toBeNull()
	})
})

describe("ambiguousRows", () => {
	it("names the arrays of objects when there are several", () => {
		expect(
			ambiguousRows({
				properties: {
					errors: list(),
					fields: list({ properties: {} }),
					ids: list({ type: "string" }),
					odd: null,
					rows: { anyOf: [list(), { type: "null" }] },
				},
			}),
		).toEqual(["fields", "rows"])
	})

	it("is empty otherwise", () => {
		expect(ambiguousRows(null)).toEqual([])
		expect(ambiguousRows(list())).toEqual([])
		expect(ambiguousRows({ type: "object" })).toEqual([])
		expect(ambiguousRows({ properties: { rows: list() } })).toEqual([])
	})
})

describe("deriveCollectionShape: rows that wrap their record", () => {
	const document = { properties: { title: { type: "string" } }, type: "object" }
	const hit = { properties: { document, highlights: list() }, type: "object" }
	/* Typesense's search answer: the record under each hit's `document`, beside object sidecars. */
	const search = {
		properties: {
			facet_counts: list(),
			found: { type: "integer" },
			hits: list(hit),
			page: { type: "integer" },
			request_params: { properties: { q: { type: "string" } }, type: "object" },
		},
		type: "object",
	} as JsonSchema

	it("reads each row's record at the declared path inside it", () => {
		expect(deriveCollectionShape(search, "$.hits[*].document")).toEqual({
			envelopeKeys: ["facet_counts", "found", "page", "request_params"],
			itemSchema: document,
			key: "hits",
			pagination: { pageKey: "page" },
			within: ["document"],
		})
	})

	it("walks a deeper path, and has no item schema where the row's schema stops", () => {
		const deep = { properties: { rows: list({ properties: { a: hit } }) }, type: "object" }
		expect(deriveCollectionShape(deep, "$.rows[*].a.document")?.itemSchema).toEqual(document)
		expect(deriveCollectionShape(deep, "$.rows[*].a.missing")).toMatchObject({ itemSchema: null, key: "rows" })
		expect(deriveCollectionShape(deep, "$.rows[*].a.document.title.x")?.itemSchema).toBeNull()
	})

	it("takes declared rows beside object siblings that would otherwise read as a document", () => {
		expect(deriveCollectionShape(search)).toBeNull()
		expect(deriveCollectionShape(search, "$.hits")?.key).toBe("hits")
	})
})

describe("rowsOf", () => {
	it("reads the top-level key a recordPath names, and the path inside each row", () => {
		expect(rowsOf("$.data")).toEqual({ key: "data", within: [] })
		expect(rowsOf("$.data[*]")).toEqual({ key: "data", within: [] })
		expect(rowsOf("$.hits[*].document")).toEqual({ key: "hits", within: ["document"] })
		expect(rowsOf("$.hits[*].a.b")).toEqual({ key: "hits", within: ["a", "b"] })
		expect(rowsOf(null)).toBeNull()
	})

	it("is null for a path that names no top-level rows", () => {
		expect(rowsOf("$.data.rows")).toBeNull()
		expect(rowsOf("$.a.b[*].c")).toBeNull()
		expect(rowsOf("$.hits[*]document")).toBeNull()
		expect(rowsOf("$.hits[*].")).toBeNull()
		expect(rowsOf("$[*].document")).toBeNull()
		expect(rowsOf("/data")).toBeNull()
	})
})
