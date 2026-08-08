/**
 * Generates the reference backend's OpenAPI document from the entity model, fully annotated with
 * the meta tags in EXTENSIONS.md. This is the "ideal citizen" spec: everything oat wants to know
 * is declared, so a run against the clean baseline exercises the tag path rather than the
 * heuristic fallbacks. The conformance suite also serves stripped variants to test the fallbacks.
 */

import { ENTITIES, type EntityDef, type FieldDef, fieldsWhere, writableFields } from "./model.ts"

type Json = Record<string, unknown>

function fieldSchema(field: FieldDef): Json {
	const base: Json = { type: field.type }
	if (field.enum !== undefined) base.enum = [...field.enum]
	if (field.maxLength !== undefined) base.maxLength = field.maxLength
	if (field.generated === true) base.readOnly = true
	if (field.nullable === true) return { oneOf: [base, { type: "null" }] }
	return base
}

function itemSchema(entity: EntityDef): Json {
	const properties: Json = {}
	for (const field of entity.fields) properties[field.name] = fieldSchema(field)
	return {
		additionalProperties: false,
		properties,
		required: entity.fields.filter((f) => f.required === true).map((f) => f.name),
		type: "object",
	}
}

function bodySchema(entity: EntityDef, phase: "create" | "update"): Json {
	const properties: Json = {}
	for (const field of writableFields(entity, phase)) properties[field.name] = fieldSchema(field)
	return {
		additionalProperties: false,
		properties,
		required: phase === "create" ? writableFields(entity, "create").filter((f) => f.required === true).map((f) => f.name) : [],
		type: "object",
	}
}

function listSchema(entity: EntityDef): Json {
	return {
		additionalProperties: false,
		properties: {
			count: { minimum: 0, type: "integer" },
			hasMore: { type: "boolean" },
			limit: { minimum: 1, type: "integer" },
			nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] },
			page: { oneOf: [{ minimum: 1, type: "integer" }, { type: "null" }] },
			[entity.plural]: { items: itemSchema(entity), type: "array" },
		},
		required: ["count", "hasMore", "limit", "nextCursor", "page", entity.plural],
		type: "object",
	}
}

function errorSchema(status: number, key: string): Json {
	return {
		additionalProperties: false,
		properties: {
			error_key: { enum: [key], type: "string" },
			message: { type: "string" },
			status: { enum: [status], type: "integer" },
			success: { const: false },
		},
		required: ["error_key", "message", "status", "success"],
		type: "object",
	}
}

const ERRORS: Array<[number, string]> = [
	[400, "invalid_input"],
	[401, "unauthorized"],
	[403, "forbidden"],
	[404, "not_found"],
	[415, "unsupported_media_type"],
]

function errorResponses(codes: number[]): Json {
	const out: Json = {}
	for (const [status, key] of ERRORS) {
		if (!codes.includes(status)) continue
		out[String(status)] = {
			content: { "application/json": { schema: { $ref: `#/components/schemas/Err${status}` } } },
			description: key,
		}
	}
	return out
}

function jsonResponse(description: string, schema: Json): Json {
	return { content: { "application/json": { schema } }, description }
}

const LIST_QUERY_PARAMS: Array<[string, Json, string]> = [
	["filter", { type: "string" }, "PostgREST-style filter expression: field.op.value, and(...), or(...)"],
	["order", { type: "string" }, "PostgREST-style sort: field[.asc|.desc][.nullsfirst|.nullslast], comma-separated"],
	["select", { type: "string" }, "Comma-separated sparse fieldset; * selects all"],
	["q", { maxLength: 200, type: "string" }, "Free-text search across the endpoint's searchable fields"],
	["cursor", { type: "string" }, "Opaque forward cursor; takes precedence over page"],
	["page", { minimum: 1, type: "integer" }, "1-based page number"],
]

function pathParams(entity: EntityDef, includeItem: boolean): Json[] {
	const params: Json[] = entity.parents.map((name) => ({
		in: "path",
		name,
		required: true,
		schema: { type: "string" },
		...(name === "project_id" ? { "x-root": true } : {}),
	}))
	if (includeItem) {
		params.push({ in: "path", name: entity.itemParam, required: true, schema: { type: "string" } })
	}
	return params
}

function tenantParam(entity: EntityDef): string {
	return entity.parents[0] ?? "project_id"
}

function buildEntityPaths(entity: EntityDef): Json {
	const listRoute = `GET ${entity.collectionPath}`
	const itemRoute = `GET ${entity.itemPath}`
	const surface = [listRoute, itemRoute]
	const title = entity.name[0]?.toUpperCase() + entity.name.slice(1)

	const query: Json = {
		filterable: fieldsWhere(entity, "filterable"),
		maxLimit: entity.maxLimit,
		searchable: fieldsWhere(entity, "searchable"),
		selectable: entity.fields.map((f) => f.name),
		sortable: fieldsWhere(entity, "sortable"),
		stableTiebreak: entity.identity,
	}

	const collection: Json = {
		get: {
			operationId: `${entity.name}.list`,
			parameters: [
				...pathParams(entity, false),
				...LIST_QUERY_PARAMS.map(([name, schema, description]) => ({
					description,
					in: "query",
					name,
					required: false,
					schema,
				})),
				{
					in: "query",
					name: "limit",
					required: false,
					schema: { default: entity.defaultLimit, maximum: entity.maxLimit, minimum: 1, type: "integer" },
				},
			],
			responses: {
				"200": jsonResponse(`List ${entity.plural}`, listSchema(entity)),
				...errorResponses([400, 401, 403, 404]),
			},
			summary: `List ${entity.plural}`,
			tags: [title],
			"x-entity": { action: "list", identity: entity.identity, name: entity.name },
			"x-query": query,
			"x-tenant": tenantParam(entity),
			...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
		},
		post: {
			operationId: `${entity.name}.create`,
			parameters: pathParams(entity, false),
			requestBody: {
				content: { "application/json": { schema: bodySchema(entity, "create") } },
				required: true,
			},
			responses: {
				"201": jsonResponse(`Created ${entity.name}`, itemSchema(entity)),
				...errorResponses([400, 401, 403, 404, 415]),
			},
			summary: `Create ${entity.name}`,
			tags: [title],
			"x-entity": { action: "create", identity: entity.identity, name: entity.name },
			"x-generated": fieldsWhere(entity, "generated"),
			"x-invalidate": [listRoute],
			"x-tenant": tenantParam(entity),
		},
	}

	const item: Json = {
		delete: {
			operationId: `${entity.name}.delete`,
			parameters: pathParams(entity, true),
			responses: {
				"200": jsonResponse(`Deleted ${entity.name}`, itemSchema(entity)),
				...errorResponses([400, 401, 403, 404]),
			},
			summary: `Delete ${entity.name}`,
			tags: [title],
			"x-entity": { action: "delete", identity: entity.identity, name: entity.name },
			"x-invalidate": surface,
			"x-tenant": tenantParam(entity),
			...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
		},
		get: {
			operationId: `${entity.name}.get`,
			parameters: pathParams(entity, true),
			responses: {
				"200": jsonResponse(entity.name, itemSchema(entity)),
				...errorResponses([400, 401, 403, 404]),
			},
			summary: `Get ${entity.name}`,
			tags: [title],
			"x-entity": { action: "read", identity: entity.identity, name: entity.name },
			"x-tenant": tenantParam(entity),
		},
		patch: {
			operationId: `${entity.name}.update`,
			parameters: pathParams(entity, true),
			requestBody: {
				content: { "application/json": { schema: bodySchema(entity, "update") } },
				required: true,
			},
			responses: {
				"200": jsonResponse(`Updated ${entity.name}`, itemSchema(entity)),
				...errorResponses([400, 401, 403, 404, 415]),
			},
			summary: `Update ${entity.name}`,
			tags: [title],
			"x-entity": { action: "update", identity: entity.identity, name: entity.name },
			"x-immutable": entity.fields.filter((f) => f.immutable === true).map((f) => f.name),
			"x-invalidate": surface,
			"x-tenant": tenantParam(entity),
		},
	}

	return { [entity.collectionPath]: collection, [entity.itemPath]: item }
}

export function buildSpec(): Json {
	const paths: Json = {}
	for (const entity of ENTITIES) Object.assign(paths, buildEntityPaths(entity))

	paths["/v1/auth/token"] = {
		post: {
			operationId: "auth.token",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							additionalProperties: false,
							properties: { key: { type: "string" } },
							required: ["key"],
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: {
				"200": jsonResponse("Access token", {
					additionalProperties: false,
					properties: {
						access_token: { type: "string" },
						expires_in: { type: "integer" },
						project_id: { type: "string" },
					},
					required: ["access_token", "expires_in", "project_id"],
					type: "object",
				}),
				...errorResponses([400, 401, 415]),
			},
			security: [],
			summary: "Exchange an API key for an access token",
			tags: ["Auth"],
		},
	}

	const schemas: Json = {}
	for (const [status, key] of ERRORS) schemas[`Err${status}`] = errorSchema(status, key)

	return {
		components: {
			schemas,
			securitySchemes: { bearer: { bearerFormat: "JWT", scheme: "bearer", type: "http" } },
		},
		info: { title: "oat reference backend", version: "1.0.0" },
		openapi: "3.1.0",
		paths,
		security: [{ bearer: [] }],
		"x-auth-flows": {
			default: {
				acquire: { credential: "$.access_token", operationId: "auth.token" },
				expiresIn: "$.expires_in",
				inject: { header: "authorization", template: "Bearer {credential}" },
			},
		},
	}
}

/** Variant with every oat meta tag removed — exercises the heuristic fallbacks. */
export function buildUntaggedSpec(): Json {
	const spec = buildSpec()
	const strip = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(strip)
		if (node === null || typeof node !== "object") return node
		const out: Json = {}
		for (const [key, value] of Object.entries(node as Json)) {
			if (key.startsWith("x-") && key !== "x-root") continue
			out[key] = strip(value)
		}
		return out
	}
	return strip(spec) as Json
}
