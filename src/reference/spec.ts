/**
 * Generates the reference backend's OpenAPI document from the entity model, fully annotated with
 * the meta tags in the README. This is the "ideal citizen" spec: everything oat wants to know
 * is declared, so a run against the clean baseline exercises the tag path rather than the
 * heuristic fallbacks. The conformance suite also serves stripped variants to test the fallbacks.
 */

import { type Dialect, POSTGREST } from "./dialect.ts"
import { ENTITIES, type EntityDef, type FieldDef, fieldsWhere, writableFields } from "./model.ts"
import type { ReferenceShape } from "./shapes.ts"

type Json = Record<string, unknown>

/** What a document is generated from: the entities as this server serves them, and its shape. */
export interface SpecContext {
	entities: readonly EntityDef[]
	shape: ReferenceShape
}

const DEFAULT_CONTEXT: SpecContext = { entities: ENTITIES, shape: {} }

function entityNamed(ctx: SpecContext, name: string): EntityDef {
	return ctx.entities.find((entity) => entity.name === name) as EntityDef
}

function fieldSchema(field: FieldDef): Json {
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

/** The schema of an identifier in a path, matching the identity it names. */
function idSchema(ctx: SpecContext, param: string): Json {
	const owner = ctx.entities.find((entity) => entity.itemParam === param)
	const identity = owner?.fields.find((field) => field.name === owner.identity)
	if (identity?.type === "integer") return { minimum: 1, type: "integer" }
	if (identity?.format === "uuid") return { format: "uuid", type: "string" }
	return { type: "string" }
}

/** A success status as the document spells it — exactly, or as the `2XX` range. */
function ok(ctx: SpecContext, status: number): string {
	return ctx.shape.rangeStatuses === true ? "2XX" : String(status)
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

/** An entity's record schema — inline, or a reference into `components` under the layout shape. */
function itemSchemaRef(ctx: SpecContext, entity: EntityDef): Json {
	return ctx.shape.specLayout === true ? { $ref: `#/components/schemas/${schemaName(entity)}` } : itemSchema(entity)
}

function schemaName(entity: EntityDef): string {
	return `${entity.name[0]?.toUpperCase() ?? ""}${entity.name.slice(1)}`
}

function bodySchema(entity: EntityDef, phase: "create" | "update", replace = false): Json {
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

function listSchema(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
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
	[409, "conflict"],
	[415, "unsupported_media_type"],
]

function errorResponses(ctx: SpecContext, codes: number[]): Json {
	/* A document may describe every failure at once: one `default` response and one schema. */
	if (ctx.shape.rangeStatuses === true) {
		return {
			default: {
				content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				description: "error",
			},
		}
	}
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
	if (p.searchMode !== undefined) {
		params.push([
			p.searchMode,
			{ default: "contains", enum: ["contains", "prefix"], type: "string" },
			"How the search term matches: anywhere in a field, or at its start",
		])
	}
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

/** A canonical `field.dir` order spelled in the dialect's own sort grammar. */
function renderOrder(dialect: Dialect, canonical: string): string {
	const [field = "", direction = "asc"] = canonical.split(".")
	switch (dialect.sortGrammar ?? "dotted") {
		case "prefixed":
			return direction === "desc" ? `-${field}` : field
		case "colon":
			return `${field}:${direction}`
		case "spaced":
			return `${field} ${direction}`
		case "dotted":
			return `${field}.${direction}`
	}
}

function pathParams(ctx: SpecContext, entity: EntityDef, includeItem: boolean): Json[] {
	const params: Json[] = entity.parents.map((name) => ({
		in: "path",
		name,
		required: true,
		schema: idSchema(ctx, name),
		...(name === "project_id" ? { "x-root": true } : {}),
	}))
	if (includeItem) {
		params.push({ in: "path", name: entity.itemParam, required: true, schema: idSchema(ctx, entity.itemParam) })
	}
	return params
}

function tenantParam(entity: EntityDef): string {
	return entity.parents[0] ?? "project_id"
}

function queryFieldType(field: FieldDef | undefined): "string" | "number" | "boolean" | "enum" | undefined {
	if (field === undefined) return undefined
	if (field.enum !== undefined) return "enum"
	if (field.type === "integer" || field.type === "number") return "number"
	if (field.type === "boolean") return "boolean"
	if (field.type === "string") return "string"
	return undefined
}

/**
 * Read routes belonging to an entity's parent, when a write here changes what they serve.
 *
 * Only the table/row relationship qualifies in this fixture: a table publishes `row_count`, so a
 * row write genuinely changes the table's representation. Declaring routes that a write does not
 * actually affect would make the invalidation check assert something false.
 */
function parentReadRoutes(ctx: SpecContext, entity: EntityDef): string[] {
	if (entity.name !== "row") return []
	const table = ctx.entities.find((candidate) => candidate.name === "table")
	if (table === undefined) return []
	return [`GET ${table.collectionPath}`, `GET ${table.itemPath}`]
}

function buildEntityPaths(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
	const listRoute = `GET ${entity.collectionPath}`
	const itemRoute = `GET ${entity.itemPath}`
	const surface = [listRoute, itemRoute]
	const title = entity.name[0]?.toUpperCase() + entity.name.slice(1)

	const catalog = entity.filterCatalog
	const query: Json = {
		/* Declared rather than inferred: the grammar decides what oat can even express. */
		grammar: dialect.grammar,
		filterable:
			catalog?.opsByField === undefined
				? fieldsWhere(entity, "filterable")
				: Object.entries(catalog.opsByField).map(([field, ops]) => {
						const def = entity.fields.find((item) => item.name === field)
						const row: Json = { field, ops: [...ops] }
						const type = queryFieldType(def)
						if (type !== undefined) row.type = type
						return row
					}),
		maxLimit: entity.maxLimit,
		searchable: fieldsWhere(entity, "searchable"),
		selectable: entity.fields.map((f) => f.name),
		sortable:
			catalog === undefined
				? fieldsWhere(entity, "sortable")
				: fieldsWhere(entity, "sortable").map((field) => {
						const def = entity.fields.find((item) => item.name === field)
						const row: Json = { field }
						const type = queryFieldType(def)
						if (type !== undefined) row.type = type
						row.nulls = ["first", "last"]
						return row
					}),
		stableTiebreak: entity.identity,
		/* Search semantics stated rather than left to inference: case-insensitive, and a blank
		 * term matches everything. */
		searchCase: "insensitive",
		searchEmpty: "match-all",
		sort: { defaultOrder: renderOrder(dialect, entity.defaultOrder) },
		...(dialect.params.searchMode === undefined ? {} : { searchModes: ["contains", "prefix"] }),
		...(entity.relations === undefined
			? {}
			: {
					select: {
						nested: true,
						relations: Object.entries(entity.relations).map(([name, relation]) => ({
							fields: [...relation.fields],
							name,
						})),
					},
				}),
		...(catalog === undefined
			? {}
			: {
					aliases: catalog.aliases ?? {},
					emptyIn: catalog.emptyIn,
					maxFilterConditions: catalog.maxFilterConditions,
					maxInValues: catalog.maxInValues,
					selectUnknown: catalog.selectUnknown,
					sortNulls: ["first", "last"],
					maxSortKeys: 3,
				}),
	}

	const collection: Json = {
		get: {
			operationId: `${entity.name}.list`,
			parameters: [
				...pathParams(ctx, entity, false),
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
				[ok(ctx, 200)]: jsonResponse(
					`List ${entity.plural}`,
					listSchema(ctx, entity, dialect),
					listResponseHeaders(dialect),
				),
				...errorResponses(ctx, [400, 401, 403, 404]),
			},
			summary: `List ${entity.plural}`,
			tags: [title],
			"x-entity": { action: "list", identity: entity.identity, name: entity.name },
			"x-query": query,
			/* Generous enough never to slow a run; declared so a stricter real limit is testable. */
			"x-rate-limit": { category: `${entity.name}.list`, rps: 500 },
			"x-tenant": tenantParam(entity),
			...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
		},
		post: {
			operationId: `${entity.name}.create`,
			parameters: [
				...pathParams(ctx, entity, false),
				/* Declared as an ordinary header parameter, because that is how real APIs publish
				 * it. oat needs no new meta tag to find this: a create operation naming a header
				 * whose name reads as an idempotency key is enough to know replay is promised. */
				{
					description:
						"Client-supplied key. Replaying a request with the same key must return the " +
						"original result rather than creating a second record.",
					in: "header",
					name: "Idempotency-Key",
					required: false,
					schema: { type: "string" },
				},
			],
			requestBody: {
				content: {
					[ctx.shape.formCreate === true ? "application/x-www-form-urlencoded" : "application/json"]: {
						schema: bodySchema(entity, "create"),
					},
				},
				required: true,
			},
			responses: {
				[ok(ctx, 201)]: jsonResponse(`Created ${entity.name}`, itemSchemaRef(ctx, entity)),
				...errorResponses(ctx, [400, 401, 403, 404, 409, 415]),
			},
			summary: `Create ${entity.name}`,
			tags: [title],
			"x-entity": { action: "create", identity: entity.identity, name: entity.name },
			"x-generated": fieldsWhere(entity, "generated"),
			...(entity.unique === undefined || entity.unique.length === 0 ? {} : { "x-unique": entity.unique }),
			/*
			 * A create invalidates its own listing, and — where the entity has a parent that
			 * carries a derived value — the parent's routes as well. Declaring it is what makes
			 * the cross-entity consistency testable rather than assumed.
			 */
			"x-invalidate": [listRoute, ...parentReadRoutes(ctx, entity)],
			"x-tenant": tenantParam(entity),
		},
	}

	const item: Json = {
		delete: {
			operationId: `${entity.name}.delete`,
			parameters: pathParams(ctx, entity, true),
			responses: {
				[ok(ctx, 200)]: jsonResponse(`Deleted ${entity.name}`, itemSchemaRef(ctx, entity)),
				...errorResponses(ctx, [400, 401, 403, 404]),
			},
			summary: `Delete ${entity.name}`,
			tags: [title],
			"x-entity": { action: "delete", identity: entity.identity, name: entity.name },
			/* A delete changes the parent's derived count just as a create does. */
			"x-invalidate": [...surface, ...parentReadRoutes(ctx, entity)],
			"x-tenant": tenantParam(entity),
			...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
		},
		get: {
			operationId: `${entity.name}.get`,
			parameters: pathParams(ctx, entity, true),
			responses: {
				[ok(ctx, 200)]: jsonResponse(entity.name, itemSchemaRef(ctx, entity)),
				...errorResponses(ctx, [400, 401, 403, 404]),
			},
			summary: `Get ${entity.name}`,
			tags: [title],
			"x-entity": { action: "read", identity: entity.identity, name: entity.name },
			"x-tenant": tenantParam(entity),
		},
		[ctx.shape.updateMethod === "PUT" ? "put" : "patch"]: {
			operationId: `${entity.name}.update`,
			parameters: pathParams(ctx, entity, true),
			requestBody: {
				content: {
					"application/json": { schema: bodySchema(entity, "update", ctx.shape.updateMethod === "PUT") },
				},
				required: true,
			},
			responses: {
				[ok(ctx, 200)]: jsonResponse(`Updated ${entity.name}`, itemSchemaRef(ctx, entity)),
				...errorResponses(ctx, [400, 401, 403, 404, 409, 415]),
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

export function buildSpec(dialect: Dialect = POSTGREST, ctx: SpecContext = DEFAULT_CONTEXT): Json {
	const TABLE = entityNamed(ctx, "table")
	const JOB = entityNamed(ctx, "job")
	const paths: Json = {}
	for (const entity of ctx.entities) Object.assign(paths, buildEntityPaths(ctx, entity, dialect))
	Object.assign(paths, callerProfilePaths(ctx))

	paths[`${TABLE.itemPath}/invites`] = {
		post: {
			operationId: "table.invite",
			parameters: pathParams(ctx, TABLE, true),
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
				[ok(ctx, 201)]: jsonResponse("Invite created", {
					additionalProperties: false,
					properties: { grant_id: { type: "string" }, token: { type: "string" } },
					required: ["grant_id", "token"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 403, 404, 415]),
			},
			summary: "Invite another principal to read this table",
			tags: ["Table"],
			"x-entity": { action: "action", identity: TABLE.identity, name: TABLE.name },
			"x-invite": {
				accept: "invite.accept",
				grantPointer: "$.grant_id",
				granteeField: "key",
				invite: "table.invite",
				revoke: "table.revoke",
				tokenPointer: "$.token",
			},
			"x-tenant": tenantParam(TABLE),
		},
	}
	paths["/v1/invites/{token}/accept"] = {
		post: {
			operationId: "invite.accept",
			parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
			responses: {
				[ok(ctx, 200)]: jsonResponse("Invite accepted", {
					additionalProperties: false,
					properties: { accepted: { type: "boolean" } },
					required: ["accepted"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 404]),
			},
			summary: "Accept an invite",
			tags: ["Table"],
			"x-entity": { action: "action", identity: TABLE.identity, name: TABLE.name },
		},
	}
	paths[`${TABLE.itemPath}/grants/{grant_id}`] = {
		delete: {
			operationId: "table.revoke",
			parameters: [
				...pathParams(ctx, TABLE, true),
				{ in: "path", name: "grant_id", required: true, schema: { type: "string" } },
			],
			responses: {
				[ok(ctx, 200)]: jsonResponse("Grant revoked", {
					additionalProperties: false,
					properties: { revoked: { type: "boolean" } },
					required: ["revoked"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 403, 404]),
			},
			summary: "Revoke a grant",
			tags: ["Table"],
			"x-entity": { action: "action", identity: TABLE.identity, name: TABLE.name },
			"x-tenant": tenantParam(TABLE),
		},
	}

	/* The async lifecycle: a start operation returning a receipt, and a poll route that
	 * eventually reports a terminal state. x-async ties the two together. */
	paths[`${JOB.collectionPath}/start`] = {
		post: {
			operationId: "job.start",
			parameters: pathParams(ctx, JOB, false),
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
				[ok(ctx, 202)]: jsonResponse("Job accepted", {
					additionalProperties: false,
					properties: { accepted: { type: "boolean" }, job_id: { type: "string" } },
					required: ["job_id", "accepted"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 403, 404, 415]),
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

	/* A write whose effect arrives elsewhere, later. x-wait tells oat where to look and how long. */
	paths[`${JOB.collectionPath.replace("/jobs", "")}/notifications`] = {
		post: {
			operationId: "job.notify",
			parameters: pathParams(ctx, JOB, false),
			requestBody: {
				content: {
					"application/json": {
						schema: {
							additionalProperties: false,
							properties: { message: { maxLength: 200, minLength: 1, type: "string" } },
							required: ["message"],
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: {
				[ok(ctx, 202)]: jsonResponse("Notification queued", {
					additionalProperties: false,
					properties: { accepted: { type: "boolean" }, notification_id: { type: "string" } },
					required: ["accepted", "notification_id"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 403, 404, 415]),
			},
			summary: "Queue a notification for delivery to the project inbox",
			tags: ["Job"],
			"x-entity": { action: "action", identity: "id", name: "job" },
			"x-tenant": tenantParam(JOB),
			"x-wait": { operationId: "job.inbox", timeoutMs: 2000, until: "$.messages[0]" },
		},
	}
	paths[`${JOB.collectionPath.replace("/jobs", "")}/inbox`] = {
		get: {
			operationId: "job.inbox",
			parameters: pathParams(ctx, JOB, false),
			responses: {
				[ok(ctx, 200)]: jsonResponse("Delivered notifications", {
					additionalProperties: false,
					properties: {
						messages: {
							items: {
								additionalProperties: false,
								properties: { id: { type: "string" }, message: { type: "string" } },
								required: ["id", "message"],
								type: "object",
							},
							type: "array",
						},
					},
					required: ["messages"],
					type: "object",
				}),
				...errorResponses(ctx, [401, 403, 404]),
			},
			summary: "List delivered notifications",
			tags: ["Job"],
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
				[ok(ctx, 200)]: jsonResponse("Access token", {
					additionalProperties: false,
					properties: {
						access_token: { type: "string" },
						expires_in: { type: "integer" },
						project_id: { type: "string" },
					},
					required: ["access_token", "expires_in", "project_id"],
					type: "object",
				}),
				...errorResponses(ctx, [400, 401, 415]),
			},
			security: [],
			summary: "Exchange an API key for an access token",
			tags: ["Auth"],
		},
	}

	const schemas: Json = {}
	for (const [status, key] of ERRORS) schemas[`Err${status}`] = errorSchema(status, key)
	schemas.Error = {
		additionalProperties: false,
		properties: {
			error_key: { type: "string" },
			message: { type: "string" },
			status: { type: "integer" },
			success: { const: false },
		},
		required: ["error_key", "message", "status", "success"],
		type: "object",
	}
	schemas.Point = {
		additionalProperties: false,
		properties: { x: { type: "integer" }, y: { type: "integer" } },
		required: ["x", "y"],
		type: "object",
	}
	/* Recursive: a node's children are nodes. Real documents describe trees, comment threads and
	 * org charts this way, and nothing about it is unusual — except to a tool that inlines refs. */
	schemas.TreeNode = {
		properties: {
			children: { items: { $ref: "#/components/schemas/TreeNode" }, type: "array" },
			name: { type: "string" },
		},
		required: ["name"],
		type: "object",
	}

	if (ctx.shape.specLayout === true) {
		for (const entity of ctx.entities) schemas[schemaName(entity)] = itemSchema(entity)
	}
	const components = {
		schemas,
		securitySchemes: { bearer: { bearerFormat: "JWT", scheme: "bearer", type: "http" } },
	}
	const rest = {
		security: [{ bearer: [] }],
		"x-auth-flows": {
			default: {
				acquire: { credential: "$.access_token", operationId: "auth.token" },
				expiresIn: "$.expires_in",
				inject: { header: "authorization", template: "Bearer {credential}" },
			},
		},
	}
	const head = { info: { title: "oat reference backend", version: "1.0.0" }, openapi: "3.1.0" }
	/* Key order is the layout: a document is free to define its components before its paths, and
	 * to declare path parameters once on the path item rather than on every operation. */
	if (ctx.shape.specLayout === true) {
		return { ...head, components, paths: hoistPathParameters(paths), ...rest }
	}
	return { ...head, paths, components, ...rest }
}

/** The signed-up caller is the record. No list, no create, no path id. */
function callerProfilePaths(ctx: SpecContext): Json {
	const schema: Json = {
		additionalProperties: false,
		properties: { first_name: { maxLength: 64, type: "string" } },
		required: ["first_name"],
		type: "object",
	}
	return {
		"/v1/me": {
			get: {
				operationId: "profile.get",
				responses: {
					[ok(ctx, 200)]: jsonResponse("The signed-up caller", schema),
					...errorResponses(ctx, [401]),
				},
				summary: "Read the signed-up caller",
				tags: ["Profile"],
				"x-entity": { action: "read", identity: "self", name: "profile" },
			},
			patch: {
				operationId: "profile.update",
				requestBody: {
					content: { "application/json": { schema } },
					required: true,
				},
				responses: {
					[ok(ctx, 200)]: jsonResponse("The signed-up caller", schema),
					...errorResponses(ctx, [400, 401]),
				},
				summary: "Update the signed-up caller",
				tags: ["Profile"],
				"x-entity": { action: "update", identity: "self", name: "profile" },
				"x-invalidate": ["GET /v1/me"],
			},
		},
	}
}

/** Moves each path item's `in: path` parameters from its operations onto the path item itself. */
function hoistPathParameters(paths: Json): Json {
	const out: Json = {}
	for (const [route, item] of Object.entries(paths)) {
		const operations = Object.entries(item as Json)
		const shared = new Map<string, Json>()
		const hoisted: Json = {}
		for (const [method, operation] of operations) {
			const parameters = ((operation as Json).parameters ?? []) as Json[]
			for (const parameter of parameters) {
				if (parameter.in === "path") shared.set(String(parameter.name), parameter)
			}
			hoisted[method] = {
				...(operation as Json),
				parameters: parameters.filter((parameter) => parameter.in !== "path"),
			}
		}
		out[route] = shared.size === 0 ? item : { parameters: [...shared.values()], ...hoisted }
	}
	return out
}

/** Variant with every oat meta tag removed — exercises the heuristic fallbacks. */
export function buildUntaggedSpec(dialect: Dialect = POSTGREST, ctx: SpecContext = DEFAULT_CONTEXT): Json {
	const spec = buildSpec(dialect, ctx)
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
