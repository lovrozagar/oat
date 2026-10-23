import { describe, expect, it } from "vitest"
import { report } from "../../src/report/console/report.ts"
import { recordOf } from "../../src/runtime/world/records.ts"
import { deriveCollectionShape } from "../../src/spec/collection/shape.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Some APIs keep the record inside an envelope: `{ data: { ID, ... }, fields: [...] }` on a read,
 * `{ success, id, message, data }` on a create, and an update that answers `{ success, id, message }`
 * with no record at all. `x-entity.recordPath` says where the record is, per operation. A path
 * that names nothing means there is no record to compare, never an empty one: compared against
 * `{}`, every field would read as dropped. A list with two arrays of objects is ambiguous until
 * `recordPath` names the rows.
 */

const ITEM = { properties: { ID: { type: "integer" }, name: { type: "string" } }, type: "object" }
const FIELDS = {
	items: { properties: { name: { type: "string" }, type: { type: "string" } }, type: "object" },
	type: "array",
}
const LIST = {
	properties: { data: { items: ITEM, type: "array" }, fields: FIELDS, totalCount: { type: "integer" } },
	type: "object",
}

const json = (schema: unknown) => ({ content: { "application/json": { schema } }, description: "ok" })

function document(listTag: Record<string, unknown> | undefined): OpenApiDocument {
	return {
		info: { title: "records", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "note.list",
					responses: { "200": json(LIST) },
					...(listTag === undefined ? {} : { "x-entity": listTag }),
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: ITEM } } },
					responses: { "201": json({ properties: { data: ITEM, id: { type: "integer" } }, type: "object" }) },
					"x-entity": { createdIdFrom: "$.id", recordPath: "$.data" },
				},
			},
			"/v1/notes/{ID}": {
				get: {
					operationId: "note.read",
					parameters: [{ in: "path", name: "ID", required: true, schema: { type: "integer" } }],
					responses: { "200": json({ properties: { data: ITEM, fields: FIELDS }, type: "object" }) },
					"x-entity": { recordPath: "$.data" },
				},
			},
		},
	} as unknown as OpenApiDocument
}

describe("x-entity.recordPath", () => {
	it("is read per operation, alone or beside createdIdFrom", () => {
		const model = buildModel(document({ recordPath: "$.data" }))
		expect(model.byOperationId.get("note.read")?.recordPath).toBe("$.data")
		expect(model.byOperationId.get("note.create")?.recordPath).toBe("$.data")
		expect(model.byOperationId.get("note.create")?.createdIdFrom).toBe("$.id")
	})
})

describe("recordOf", () => {
	const declared = { recordPath: "$.data" }
	const undeclared = { recordPath: null }

	it("is the object at the declared path", () => {
		expect(recordOf(declared, { data: { ID: 7, name: "a" }, fields: [] })).toEqual({ ID: 7, name: "a" })
	})

	it("is the body itself when nothing is declared", () => {
		expect(recordOf(undeclared, { ID: 7 })).toEqual({ ID: 7 })
	})

	it("is undefined, never empty, when the declared path names nothing", () => {
		expect(recordOf(declared, { id: 7, message: "updated", success: true })).toBeUndefined()
		expect(recordOf(undeclared, [1, 2])).toBeUndefined()
	})
})

describe("a list with two arrays of objects", () => {
	it("is no collection until something says which array holds the rows", () => {
		expect(deriveCollectionShape(LIST as never)).toBeNull()
		expect(deriveCollectionShape(LIST as never, "$.data")?.key).toBe("data")
	})

	it("takes the rows from the list operation's recordPath, and reports the ambiguity without it", () => {
		expect(buildModel(document({ recordPath: "$.data" })).byOperationId.get("note.list")?.collection?.key).toBe("data")
		const ambiguous = buildModel(document(undefined))
		expect(ambiguous.byOperationId.get("note.list")?.collection).toBeNull()
		expect(ambiguous.gaps.gaps.map((gap) => `${gap.operationId} ${gap.tag}`)).toContain("note.list x-entity.recordPath")
	})
})

/* Typesense's search: each hit wraps the record under `document`, beside object sidecars. */
const BOOK = { properties: { id: { type: "string" }, title: { type: "string" } }, type: "object" }
const SEARCH = {
	properties: {
		found: { type: "integer" },
		hits: {
			items: { properties: { document: BOOK, highlights: { items: { type: "object" }, type: "array" } } },
			type: "array",
		},
		request_params: { properties: { q: { type: "string" } }, type: "object" },
	},
	type: "object",
}

function searchDocument(recordPath: string): OpenApiDocument {
	return {
		info: { title: "search", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/books": {
				get: { operationId: "book.search", responses: { "200": json(SEARCH) }, "x-entity": { recordPath } },
			},
		},
	} as unknown as OpenApiDocument
}

describe("a list whose rows wrap their record", () => {
	it("reads each row's record where the list's recordPath points inside it", () => {
		const collection = buildModel(searchDocument("$.hits[*].document")).byOperationId.get("book.search")?.collection
		expect(collection).toMatchObject({ itemSchema: BOOK, key: "hits", within: ["document"] })
	})
})

describe("doctor", () => {
	it("prints where each operation keeps its record and its created id", () => {
		const text = report.doctor(buildModel(document({ recordPath: "$.data" }))).text
		expect(text).toContain("note.create")
		expect(text).toMatch(/note\.create\s+record \$\.data\s+created id \$\.id/)
		expect(text).toMatch(/note\.read\s+record \$\.data/)
	})

	it("prints a per-row record path as declared", () => {
		const text = report.doctor(buildModel(searchDocument("$.hits[*].document"))).text
		expect(text).toMatch(/book\.search\s+record \$\.hits\[\*\]\.document/)
	})
})
