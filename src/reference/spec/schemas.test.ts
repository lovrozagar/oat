import { describe, expect, it } from "vitest"
import { CLASSIC, LINKED, POSTGREST } from "../dialect/presets.ts"
import type { EntityDef } from "../model/types.ts"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import {
	bodySchema,
	createdSchema,
	fieldSchema,
	itemSchema,
	itemSchemaRef,
	listSchema,
	located,
	readSchema,
	schemaName,
	writtenSchema,
} from "./schemas.ts"
import type { SpecContext } from "./types.ts"

function context(shape: ReferenceShape): SpecContext {
	return { entities: shapedEntities(shape), shape }
}

function shapedTable(shape: ReferenceShape): EntityDef {
	return shapedEntities(shape).find((entity) => entity.name === "table") as EntityDef
}

describe("fieldSchema", () => {
	it("declares a field's type and every constraint it carries", () => {
		const table = shapedTable({ richSchema: true, writeOnlyField: true })
		const field = (name: string) => fieldSchema(table.fields.find((f) => f.name === name) as never)
		expect(field("due_at")).toEqual({ format: "date-time", type: "string" })
		expect(field("weight")).toEqual({ maximum: 10, minimum: 1, multipleOf: 0.5, type: "number" })
		expect(field("schema_version")).toEqual({ const: "v1", type: "string" })
		expect(field("start")).toEqual({ $ref: "#/components/schemas/Point" })
		expect(field("secret")).toEqual({ maxLength: 64, type: "string", writeOnly: true })
		expect(field("id")).toEqual({ readOnly: true, type: "string" })
		expect(field("verified")).toEqual({ type: "boolean", "x-privileged": true })
	})

	it("declares an enum, and a nullable field as one of its schema or null", () => {
		const status = TABLE.fields.find((f) => f.name === "status")
		expect(fieldSchema(status as never)).toMatchObject({ enum: status?.enum, type: "string" })
		const description = TABLE.fields.find((f) => f.name === "description")
		expect(fieldSchema(description as never)).toEqual({
			oneOf: [{ maxLength: 256, type: "string" }, { type: "null" }],
		})
	})

	it("bounds an array field's items to the values it may take", () => {
		const tags = ROW.fields.find((f) => f.name === "tags")
		expect(fieldSchema(tags as never)).toEqual({
			items: { enum: ["red", "redwood", "blue", "green"], type: "string" },
			maxItems: 5,
			type: "array",
		})
		expect(fieldSchema({ name: "free", type: "array" })).toEqual({
			items: { enum: [], type: "string" },
			maxItems: 5,
			type: "array",
		})
	})
})

describe("record schemas", () => {
	it("closes an entity's record and requires its required fields", () => {
		const schema = itemSchema(TABLE)
		expect(schema).toMatchObject({ additionalProperties: false, type: "object" })
		expect(Object.keys(schema.properties as object)).toEqual(TABLE.fields.map((f) => f.name))
		expect(schema.required).toEqual(TABLE.fields.filter((f) => f.required === true).map((f) => f.name))
	})

	it("names a component after the entity, capitalised", () => {
		expect(schemaName(TABLE)).toBe("Table")
		expect(schemaName({ ...TABLE, name: "" })).toBe("")
	})

	it("refers into components under the layout shape, and inlines otherwise", () => {
		expect(itemSchemaRef(context({ specLayout: true }), ROW)).toEqual({ $ref: "#/components/schemas/Row" })
		expect(itemSchemaRef(context({}), ROW)).toEqual(itemSchema(ROW))
	})

	it("nests a read-only related record keyed by the shape's identity field", () => {
		const renamed = itemSchemaRef(context({ identityField: "ID", relatedRecord: true }), TABLE)
		expect((renamed.properties as Record<string, unknown>)["Status"]).toEqual({
			additionalProperties: false,
			properties: { ID: { type: "integer" }, Name: { type: "string" } },
			readOnly: true,
			required: ["ID", "Name"],
			type: "object",
		})
		expect((renamed.required as string[]).at(-1)).toBe("Status")
		const plain = itemSchemaRef(context({ relatedRecord: true }), TABLE)
		expect((plain.properties as Record<string, { required: string[] }>)["Status"]?.required).toEqual(["id", "Name"])
	})
})

describe("record envelopes", () => {
	const wrapped = context({ recordEnvelope: true })
	const plain = context({})

	it("answers a create with success, id, message and the record", () => {
		const schema = createdSchema(wrapped, TABLE)
		expect(schema.required).toEqual(["success", "id", "message", "data"])
		expect((schema.properties as Record<string, unknown>)["id"]).toEqual({ readOnly: true, type: "string" })
		expect(createdSchema(plain, TABLE)).toEqual(itemSchema(TABLE))
	})

	it("answers a read with the record beside a fields sidecar", () => {
		expect(readSchema(wrapped, TABLE).required).toEqual(["data", "fields"])
		expect(readSchema(plain, TABLE)).toEqual(itemSchema(TABLE))
	})

	it("answers a write without the record", () => {
		const schema = writtenSchema(wrapped, TABLE)
		expect(schema.required).toEqual(["success", "id", "message"])
		expect(Object.keys(schema.properties as object)).not.toContain("data")
		expect(writtenSchema(plain, TABLE)).toEqual(itemSchema(TABLE))
	})

	it("declares the id as a string when the identity is not a field", () => {
		const orphan = { ...TABLE, identity: "missing" }
		expect((writtenSchema(wrapped, orphan).properties as Record<string, unknown>)["id"]).toEqual({ type: "string" })
	})

	it("keeps the async job's answers plain", () => {
		expect(createdSchema(wrapped, JOB)).toEqual(itemSchema(JOB))
		expect(located(wrapped, JOB, "create")).toEqual({})
	})

	it("says where the record and a create's id are", () => {
		expect(located(wrapped, TABLE, "create")).toEqual({ createdIdFrom: "$.id", recordPath: "$.data" })
		expect(located(wrapped, TABLE, "read")).toEqual({ recordPath: "$.data" })
		expect(located(wrapped, TABLE, "list")).toEqual({ recordPath: "$.data" })
		expect(located(plain, TABLE, "list")).toEqual({})
	})
})

describe("bodySchema", () => {
	it("requires every required writable field on create", () => {
		const schema = bodySchema(TABLE, "create")
		expect(schema.required).toContain("name")
		expect(Object.keys(schema.properties as object)).not.toContain("id")
	})

	it("requires nothing on a partial update, and everything on a replacing one", () => {
		expect(bodySchema(TABLE, "update").required).toEqual([])
		expect(bodySchema(TABLE, "update", true).required).toContain("name")
	})
})

describe("listSchema", () => {
	const ctx: SpecContext = { entities: ENTITIES, shape: {} }

	it("is the bare array when the dialect has no envelope", () => {
		expect(listSchema(ctx, TABLE, LINKED)).toEqual({ items: itemSchema(TABLE), type: "array" })
	})

	it("names the collection after the entity and declares each pagination fact", () => {
		const schema = listSchema(ctx, TABLE, POSTGREST)
		const env = POSTGREST.envelope as Record<string, string>
		expect(schema.required).toEqual(
			["tables", env["hasMore"], env["limit"], env["page"], env["total"], env["nextCursor"]].filter(
				(k) => k !== undefined,
			),
		)
		expect(schema.additionalProperties).toBe(false)
	})

	it("uses a dialect's fixed collection key", () => {
		const schema = listSchema(ctx, TABLE, CLASSIC)
		expect((schema.required as string[])[0]).toBe(CLASSIC.envelope?.collection)
	})

	it("carries the fields sidecar beside wrapped rows", () => {
		const schema = listSchema(context({ recordEnvelope: true }), TABLE, POSTGREST)
		expect((schema.required as string[]).at(-1)).toBe("fields")
	})
})
