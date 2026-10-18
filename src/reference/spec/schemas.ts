/** The record, body and listing schemas a document declares for each entity. */

import type { Dialect } from "../dialect.ts"
import { type EntityDef, type FieldDef, writableFields } from "../model.ts"
import type { Json, SpecContext } from "./types.ts"

export function fieldSchema(field: FieldDef): Json {
	const base: Json = field.ref === undefined ? { type: field.type } : { $ref: `#/components/schemas/${field.ref}` }
	if (field.type === "array") {
		base.items = { enum: [...(field.items ?? [])], type: "string" }
		base.maxItems = 5
	}
	if (field.format !== undefined) base.format = field.format
	if (field.minimum !== undefined) base.minimum = field.minimum
	if (field.maximum !== undefined) base.maximum = field.maximum
	if (field.multipleOf !== undefined) base.multipleOf = field.multipleOf
	if (field.const !== undefined) base.const = field.const
	if (field.enum !== undefined) base.enum = [...field.enum]
	if (field.maxLength !== undefined) base.maxLength = field.maxLength
	if (field.generated === true) base.readOnly = true
	if (field.writeOnly === true) base.writeOnly = true
	if (field.nullable === true) return { oneOf: [base, { type: "null" }] }
	return base
}

export function itemSchema(entity: EntityDef): Json {
	const properties: Json = {}
	for (const field of entity.fields) properties[field.name] = fieldSchema(field)
	return {
		additionalProperties: false,
		properties,
		required: entity.fields.filter((f) => f.required === true).map((f) => f.name),
		type: "object",
	}
}

export function schemaName(entity: EntityDef): string {
	return `${entity.name[0]?.toUpperCase() ?? ""}${entity.name.slice(1)}`
}

/** An entity's record schema — inline, or a reference into `components` under the layout shape. */
export function itemSchemaRef(ctx: SpecContext, entity: EntityDef): Json {
	if (ctx.shape.specLayout === true) return { $ref: `#/components/schemas/${schemaName(entity)}` }
	const schema = itemSchema(entity) as { properties: Record<string, Json>; required: string[] }
	if (ctx.shape.relatedRecord === true) {
		const id = ctx.shape.identityField ?? "id"
		schema.properties.Status = {
			additionalProperties: false,
			properties: { Name: { type: "string" }, [id]: { type: "integer" } },
			readOnly: true,
			required: [id, "Name"],
			type: "object",
		}
		schema.required.push("Status")
	}
	return schema as Json
}

/* Under `recordEnvelope`: the answers' shapes, and where the document says the record is. */
const FIELD_LIST: Json = {
	items: {
		additionalProperties: false,
		properties: { name: { type: "string" }, type: { type: "string" } },
		required: ["name", "type"],
		type: "object",
	},
	type: "array",
}

function identitySchema(entity: EntityDef): Json {
	const field = entity.fields.find((candidate) => candidate.name === entity.identity)
	return field === undefined ? { type: "string" } : fieldSchema(field)
}
/* The async job is an action's receipt, not a record: its answers stay plain. */
function wraps(ctx: SpecContext, entity: EntityDef): boolean {
	return ctx.shape.recordEnvelope === true && entity.name !== "job"
}
export function createdSchema(ctx: SpecContext, entity: EntityDef): Json {
	if (!wraps(ctx, entity)) return itemSchemaRef(ctx, entity)
	return {
		additionalProperties: false,
		properties: {
			data: itemSchemaRef(ctx, entity),
			id: identitySchema(entity),
			message: { type: "string" },
			success: { type: "boolean" },
		},
		required: ["success", "id", "message", "data"],
		type: "object",
	}
}
export function readSchema(ctx: SpecContext, entity: EntityDef): Json {
	if (!wraps(ctx, entity)) return itemSchemaRef(ctx, entity)
	return {
		additionalProperties: false,
		properties: { data: itemSchemaRef(ctx, entity), fields: FIELD_LIST },
		required: ["data", "fields"],
		type: "object",
	}
}
export function writtenSchema(ctx: SpecContext, entity: EntityDef): Json {
	if (!wraps(ctx, entity)) return itemSchemaRef(ctx, entity)
	return {
		additionalProperties: false,
		properties: { id: identitySchema(entity), message: { type: "string" }, success: { type: "boolean" } },
		required: ["success", "id", "message"],
		type: "object",
	}
}
export function located(ctx: SpecContext, entity: EntityDef, action: "create" | "read" | "list"): Json {
	if (!wraps(ctx, entity)) return {}
	return action === "create" ? { createdIdFrom: "$.id", recordPath: "$.data" } : { recordPath: "$.data" }
}

export function bodySchema(entity: EntityDef, phase: "create" | "update", replace = false): Json {
	const properties: Json = {}
	for (const field of writableFields(entity, phase)) properties[field.name] = fieldSchema(field)
	return {
		additionalProperties: false,
		properties,
		/* A create, and a replacing update, must carry every required field; a PATCH need not. */
		required:
			phase === "create" || replace
				? writableFields(entity, phase)
						.filter((f) => f.required === true)
						.map((f) => f.name)
				: [],
		type: "object",
	}
}

/** The collection's property name under a dialect — entity-named, or a fixed key like `data`. */
function collectionKey(entity: EntityDef, dialect: Dialect): string {
	return dialect.envelope?.collection ?? entity.plural
}

export function listSchema(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
	const env = dialect.envelope
	/* No envelope: the response *is* the array. A document that says so is the only place oat can
	 * learn it, so the schema has to say it rather than describe a wrapper that does not exist. */
	if (env === null) return { items: itemSchemaRef(ctx, entity), type: "array" }
	const key = collectionKey(entity, dialect)
	const properties: Json = { [key]: { items: itemSchemaRef(ctx, entity), type: "array" } }
	const required = [key]
	const declare = (name: string | undefined, schema: Json): void => {
		if (name === undefined) return
		properties[name] = schema
		required.push(name)
	}
	declare(env.hasMore, { type: "boolean" })
	declare(env.limit, { minimum: 1, type: "integer" })
	declare(env.page, { oneOf: [{ minimum: 1, type: "integer" }, { type: "null" }] })
	declare(env.total, { minimum: 0, type: "integer" })
	declare(env.nextCursor, { oneOf: [{ type: "string" }, { type: "null" }] })
	if (wraps(ctx, entity)) declare("fields", FIELD_LIST)
	return { additionalProperties: false, properties, required, type: "object" }
}
