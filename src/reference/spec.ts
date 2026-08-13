/**
 * Generates the reference backend's OpenAPI document from the entity model, fully annotated with
 * the meta tags in EXTENSIONS.md. This is the "ideal citizen" spec: everything oat wants to know
 * is declared, so a run against the clean baseline exercises the tag path rather than the
 * heuristic fallbacks. The conformance suite also serves stripped variants to test the fallbacks.
 */

import { type Dialect, POSTGREST } from "./dialect.ts"
import { ENTITIES, type EntityDef, type FieldDef, JOB, fieldsWhere, writableFields } from "./model.ts"

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

/** The collection's property name under a dialect — entity-named, or a fixed key like `data`. */
function collectionKey(entity: EntityDef, dialect: Dialect): string {
	return dialect.envelope?.collection ?? entity.plural
}

function listSchema(entity: EntityDef, dialect: Dialect): Json {
	const env = dialect.envelope
	/* No envelope: the response *is* the array. A document that says so is the only place oat can
	 * learn it, so the schema has to say it rather than describe a wrapper that does not exist. */
	if (env === null) return { items: itemSchema(entity), type: "array" }
	const key = collectionKey(entity, dialect)
	const properties: Json = {
		[env.hasMore]: { type: "boolean" },
		[env.limit]: { minimum: 1, type: "integer" },
		[env.page]: { oneOf: [{ minimum: 1, type: "integer" }, { type: "null" }] },
		[env.total]: { minimum: 0, type: "integer" },
		[key]: { items: itemSchema(entity), type: "array" },
	}
	const required = [env.hasMore, env.limit, env.page, env.total, key]
	if (env.nextCursor !== undefined) {
		properties[env.nextCursor] = { oneOf: [{ type: "string" }, { type: "null" }] }
		required.push(env.nextCursor)
	}
	return { additionalProperties: false, properties, required, type: "object" }
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

function jsonResponse(description: string, schema: Json, headers?: Json): Json {
	const response: Json = { content: { "application/json": { schema } }, description }
	if (headers !== undefined) response.headers = headers
	return response
}

/** RFC 8288 pagination links, declared only by dialects that actually publish them. */
function listResponseHeaders(dialect: Dialect): Json | undefined {
	if (dialect.envelope !== null) return undefined
	return {
		Link: {
			description: 'Pagination links; rel="next" is present while further pages remain',
			schema: { type: "string" },
		},
	}
}

/**
 * The sort parameter's description, demonstrating the grammar this dialect expects.
 *
 * A document that expects `-created_at` and describes `field.asc` is lying, and oat would infer
 * the wrong grammar from it — correctly, since the document is the only thing it can read.
 */
function sortDescription(dialect: Dialect): string {
	switch (dialect.sortGrammar ?? "dotted") {
		case "prefixed":
			return "Sort by field; prefix with - for descending. e.g. -created_at, name"
		case "colon":
			return "Sort: field:asc or field:desc, comma-separated. e.g. created_at:desc"
		case "spaced":
			return "Sort: field asc or field desc, comma-separated. e.g. created_at desc"
		case "dotted":
			return "Sort: field[.asc|.desc][.nullsfirst|.nullslast], comma-separated"
	}
}

function listQueryParams(dialect: Dialect, entity: EntityDef): Array<[string, Json, string]> {
	const p = dialect.params
	const filterDescription =
		dialect.grammar === "postgrest"
			? "PostgREST-style filter expression: field.op.value, and(...), or(...)"
			: "Filter expression: field=op:value, comma-separated. e.g. status=eq:active"
	const params: Array<[string, Json, string]> = []
	if (dialect.grammar === "equality") {
		/* One parameter per filterable field, which *is* the filter language here. Declaring them
		 * individually is the only way a document can express this shape, and it is how oat learns
		 * what may be filtered on. */
		for (const field of fieldsWhere(entity, "filterable")) {
			const declared = entity.fields.find((f) => f.name === field)
			const numeric = declared?.type === "integer" || declared?.type === "number"
			params.push([
				field,
				declared?.enum === undefined
					? { type: numeric ? "number" : "string" }
					: { enum: declared.enum, type: "string" },
				`Exact match on ${field}`,
			])
		}
	} else {
		params.push([p.filter, { type: "string" }, filterDescription])
	}
	params.push(
		[p.order, { type: "string" }, sortDescription(dialect)],
		[
			/* JSON:API carries the resource type in the parameter *name*, so the name itself is
			 * part of the grammar and has to be declared per entity. */
			dialect.selectGrammar === "bracketed" ? `${p.select}[${entity.name}]` : p.select,
			{ type: "string" },
			"Comma-separated sparse fieldset; * selects all",
		],
		[p.search, { maxLength: 200, type: "string" }, "Free-text search across searchable fields"],
	)
	/* Exactly one paging model is published, because that is what a real document does — and a
	 * document advertising a parameter the backend ignores is itself a defect oat reports. */
	if (p.page !== undefined) {
		params.push([p.page, { minimum: 1, type: "integer" }, "1-based page number"])
	}
	if (p.offset !== undefined) {
		params.push([p.offset, { minimum: 0, type: "integer" }, "Number of records to skip"])
	}
	if (p.cursor !== undefined) {
		params.push([p.cursor, { type: "string" }, "Opaque forward cursor; takes precedence over page"])
	}
	return params
}

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

/**
 * Read routes belonging to an entity's parent, when a write here changes what they serve.
 *
 * Only the table/row relationship qualifies in this fixture: a table publishes `row_count`, so a
 * row write genuinely changes the table's representation. Declaring routes that a write does not
 * actually affect would make the invalidation check assert something false.
 */
function parentReadRoutes(entity: EntityDef): string[] {
	if (entity.name !== "row") return []
	const table = ENTITIES.find((candidate) => candidate.name === "table")
	if (table === undefined) return []
	return [`GET ${table.collectionPath}`, `GET ${table.itemPath}`]
}

function buildEntityPaths(entity: EntityDef, dialect: Dialect): Json {
	const listRoute = `GET ${entity.collectionPath}`
	const itemRoute = `GET ${entity.itemPath}`
	const surface = [listRoute, itemRoute]
	const title = entity.name[0]?.toUpperCase() + entity.name.slice(1)

	const query: Json = {
		/* Declared rather than inferred: the grammar decides what oat can even express. */
		grammar: dialect.grammar,
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
				...listQueryParams(dialect, entity).map(([name, schema, description]) => ({
					description,
					in: "query",
					name,
					required: false,
					schema,
				})),
				{
					in: "query",
					name: dialect.params.limit,
					required: false,
					schema: { default: entity.defaultLimit, maximum: entity.maxLimit, minimum: 1, type: "integer" },
				},
			],
			responses: {
				"200": jsonResponse(
					`List ${entity.plural}`,
					listSchema(entity, dialect),
					listResponseHeaders(dialect),
				),
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
			parameters: [
				...pathParams(entity, false),
				/* Declared as an ordinary header parameter, because that is how real APIs publish
				 * it. oat needs no new meta tag to find this: a create operation naming a header
				 * whose name reads as an idempotency key is enough to know replay is promised. */
				{
					description:
						"Client-supplied key. Replaying a request with the same key must return the "
						+ "original result rather than creating a second record.",
					in: "header",
					name: "Idempotency-Key",
					required: false,
					schema: { type: "string" },
				},
			],
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
			/*
			 * A create invalidates its own listing, and — where the entity has a parent that
			 * carries a derived value — the parent's routes as well. Declaring it is what makes
			 * the cross-entity consistency testable rather than assumed.
			 */
			"x-invalidate": [listRoute, ...parentReadRoutes(entity)],
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
			/* Declared here as well as on create. Real documents often list server-owned fields
			 * only where they are conspicuous — the fields a caller may not supply — and a tool
			 * that reads just one operation then treats a generated field as client-owned. */
			"x-generated": fieldsWhere(entity, "generated"),
			"x-immutable": entity.fields.filter((f) => f.immutable === true).map((f) => f.name),
			"x-invalidate": surface,
			"x-tenant": tenantParam(entity),
		},
	}

	return { [entity.collectionPath]: collection, [entity.itemPath]: item }
}

export function buildSpec(dialect: Dialect = POSTGREST): Json {
	const paths: Json = {}
	for (const entity of ENTITIES) Object.assign(paths, buildEntityPaths(entity, dialect))

	/* The async lifecycle: a start operation returning a receipt, and a poll route that
	 * eventually reports a terminal state. x-async ties the two together. */
	paths[`${JOB.collectionPath}/start`] = {
		post: {
			operationId: "job.start",
			parameters: pathParams(JOB, false),
			requestBody: {
				content: {
					"application/json": {
						schema: {
							additionalProperties: false,
							properties: { name: { maxLength: 128, minLength: 1, type: "string" } },
							required: ["name"],
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: {
				"202": jsonResponse("Job accepted", {
					additionalProperties: false,
					properties: { accepted: { type: "boolean" }, job_id: { type: "string" } },
					required: ["job_id", "accepted"],
					type: "object",
				}),
				...errorResponses([400, 401, 403, 404, 415]),
			},
			summary: "Start a job",
			tags: ["Job"],
			"x-async": {
				idFrom: "$.job_id",
				poll: `GET ${JOB.itemPath}`,
				pollIntervalMs: 20,
				successWhen: "status.eq.complete",
				timeoutMs: 3000,
				until: "status.in.(complete,failed)",
			},
			"x-effects": [{ count: 1, entity: "job", op: "create" }],
			"x-entity": { action: "action", identity: "id", name: "job" },
			"x-tenant": tenantParam(JOB),
		},
	}

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
export function buildUntaggedSpec(dialect: Dialect = POSTGREST): Json {
	const spec = buildSpec(dialect)
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
