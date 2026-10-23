import { allColumns, ancestors, type Entity, type World } from "./types.ts"

/* The schema and parameter pieces the spec's operations are built from. */

export type Json = Record<string, unknown>

export function objectSchema(properties: Json, required: string[]): Json {
	return { properties, required, type: "object" }
}

export function keyBody(): Json {
	return {
		content: { "application/json": { schema: objectSchema({ key: { type: "string" } }, ["key"]) } },
		required: true,
	}
}

export function queryTag(world: World, entity: Entity): Json {
	const cols = allColumns(entity)
	const flagged = (flag: "filterable" | "sortable" | "searchable"): string[] =>
		entity.fields.filter((f) => f[flag] === true).map((f) => f.name)
	const filterable = ["id", "org_id", ...flagged("filterable"), "created_at", "updated_at"]
	if (world.defects?.includes("overclaim-filter")) filterable.push("ghost")
	const sortable = ["id", ...flagged("sortable"), "created_at", "updated_at"]
	if (world.defects?.includes("overclaim-sort")) sortable.push("ghost")
	const searchable = flagged("searchable")
	const selectable = [...cols]
	if (world.defects?.includes("overclaim-select")) selectable.push("ghost")
	return {
		defaultOrder: "created_at.desc",
		filterable,
		grammar: "postgrest",
		maxLimit: entity.maxLimit ?? 100,
		searchable,
		selectable,
		sortable,
		stableTiebreak: "id",
	}
}

export function queryParams(world: World, entity: Entity): Json[] {
	const names = world.queryNames ?? {
		filter: "filter",
		limit: "limit",
		order: "order",
		search: "q",
		select: "select",
	}
	return [
		{
			description: "PostgREST-style filter: field.op.value",
			in: "query",
			name: names.filter,
			schema: { type: "string" },
		},
		{ description: "Sort: field[.asc|.desc]", in: "query", name: names.order, schema: { type: "string" } },
		{ description: "Comma-separated sparse fieldset", in: "query", name: names.select, schema: { type: "string" } },
		{ description: "Free-text search", in: "query", name: names.search, schema: { type: "string" } },
		{
			in: "query",
			name: names.limit,
			schema: { default: 20, maximum: entity.maxLimit ?? 100, minimum: 1, type: "integer" },
		},
		{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
		{ in: "query", name: "cursor", schema: { type: "string" } },
	]
}

export function pathParam(name: string): Json {
	return { in: "path", name, required: true, schema: { type: "string" } }
}

export function pathParams(world: World, entity: Entity, item: boolean): Json[] {
	const names = ["org_id", ...ancestors(world, entity).map((a) => `${a.name}_id`)]
	if (item) names.push(`${entity.name}_id`)
	return names.map(pathParam)
}

export function itemSchema(entity: Entity): Json {
	const properties: Json = {
		id: { type: "string" },
		org_id: { type: "string" },
		created_at: { type: "integer" },
		updated_at: { type: "integer" },
	}
	const parent = entity.parent === undefined ? null : `${entity.parent}_id`
	if (parent !== null) properties[parent] = { type: "string" }
	for (const field of entity.fields) properties[field.name] = fieldSchema(field)
	for (const derived of entity.derived ?? []) properties[derived.name] = { type: "integer" }
	if (entity.softDelete === true) properties["deleted_at"] = { type: ["integer", "null"] }
	return objectSchema(properties, [
		"id",
		"org_id",
		...entity.fields.filter((f) => f.required === true).map((f) => f.name),
		"created_at",
		"updated_at",
	])
}

export function writeSchema(entity: Entity, phase: "create" | "update"): Json {
	const properties: Json = {}
	for (const field of entity.fields) {
		if (field.generated === true) continue
		properties[field.name] = fieldSchema(field)
	}
	return objectSchema(
		properties,
		phase === "create" ? entity.fields.filter((f) => f.required === true).map((f) => f.name) : [],
	)
}

function fieldSchema(field: { type: string; enum?: readonly string[]; maxLength?: number; nullable?: boolean }): Json {
	const type = field.nullable === true ? [field.type, "null"] : field.type
	const schema: { type: string | string[]; enum?: string[]; maxLength?: number } = { type }
	if (field.enum !== undefined) schema.enum = [...field.enum]
	if (field.maxLength !== undefined) schema.maxLength = field.maxLength
	return schema
}

export function generated(entity: Entity): string[] {
	const names = ["id", "org_id", "created_at", "updated_at"]
	if (entity.softDelete === true) names.push("deleted_at")
	for (const derived of entity.derived ?? []) names.push(derived.name)
	for (const field of entity.fields) {
		if (field.generated === true) names.push(field.name)
	}
	return names
}

export function ok(schema: Json, description: string): Json {
	return { content: { "application/json": { schema } }, description }
}

export function error(status: number): Json {
	return ok(
		objectSchema({ error_key: { type: "string" }, message: { type: "string" } }, ["error_key", "message"]),
		String(status),
	)
}
