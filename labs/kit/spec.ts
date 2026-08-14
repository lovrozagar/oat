import {
	allColumns,
	ancestors,
	collectionPath,
	entityByName,
	itemPath,
	type Entity,
	type World,
} from "./types.ts"

type Json = Record<string, unknown>

export function buildSpec(world: World): Json {
	const paths: Json = {
		"/v1/auth/token": {
			post: {
				operationId: "auth.token",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: { key: { type: "string" } },
								required: ["key"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										access_token: { type: "string" },
										org_id: { type: "string" },
									},
									required: ["access_token", "org_id"],
									type: "object",
								},
							},
						},
						description: "Credential",
					},
					"401": error(401),
				},
				summary: "Exchange an API key for a bearer token",
			},
		},
	}

	for (const entity of world.entities) {
		const list = collectionPath(world, entity)
		const item = itemPath(world, entity)
		const surface = [`GET ${list}`, `GET ${item}`]
		const parentRoutes = parentInvalidate(world, entity)
		const query = queryTag(world, entity)
		const params = pathParams(world, entity, false)
		const itemParams = pathParams(world, entity, true)

		paths[list] = {
			get: {
				operationId: `${entity.name}.list`,
				parameters: [...params, ...queryParams(world, entity)],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										[entity.plural]: { items: itemSchema(entity), type: "array" },
										count: { type: "integer" },
										hasMore: { type: "boolean" },
										limit: { type: "integer" },
										nextCursor: { type: ["string", "null"] },
										page: { type: "integer" },
									},
									required: [entity.plural, "count", "hasMore"],
									type: "object",
								},
							},
						},
						description: `A page of ${entity.plural}`,
					},
					"400": error(400),
				},
				summary: `List ${entity.plural}`,
				"x-entity": { action: "list", identity: entity.identity, name: entity.name },
				"x-query": query,
				"x-tenant": "org_id",
			},
			post: {
				operationId: `${entity.name}.create`,
				parameters: [
					...params,
					{ in: "header", name: "Idempotency-Key", required: false, schema: { type: "string" } },
				],
				requestBody: {
					content: { "application/json": { schema: writeSchema(entity, "create") } },
					required: true,
				},
				responses: {
					"201": ok(itemSchema(entity), "Created"),
					"400": error(400),
					"415": error(415),
				},
				summary: `Create ${entity.name}`,
				"x-entity": { action: "create", identity: entity.identity, name: entity.name },
				"x-generated": generated(entity),
				"x-invalidate": [`GET ${list}`, ...parentRoutes],
				"x-tenant": "org_id",
			},
		}

		paths[item] = {
			delete: {
				operationId: `${entity.name}.delete`,
				parameters: itemParams,
				responses: { "204": { description: "Deleted" }, "404": error(404) },
				summary: `Delete ${entity.name}`,
				"x-entity": { action: "delete", identity: entity.identity, name: entity.name },
				"x-invalidate": [...surface, ...parentRoutes],
				"x-tenant": "org_id",
				...(entity.softDelete === true ? { "x-soft-delete": "deleted_at" } : {}),
			},
			get: {
				operationId: `${entity.name}.get`,
				parameters: itemParams,
				responses: { "200": ok(itemSchema(entity), entity.name), "404": error(404) },
				summary: `Read ${entity.name}`,
				"x-entity": { action: "read", identity: entity.identity, name: entity.name },
				"x-tenant": "org_id",
			},
			patch: {
				operationId: `${entity.name}.update`,
				parameters: itemParams,
				requestBody: {
					content: { "application/json": { schema: writeSchema(entity, "update") } },
					required: true,
				},
				responses: {
					"200": ok(itemSchema(entity), "Updated"),
					"400": error(400),
					"404": error(404),
					"415": error(415),
				},
				summary: `Update ${entity.name}`,
				"x-entity": { action: "update", identity: entity.identity, name: entity.name },
				"x-generated": generated(entity),
				"x-immutable": ["id", "org_id", "created_at"],
				"x-invalidate": [...surface, ...parentRoutes],
				"x-tenant": "org_id",
			},
		}

		if (entity.invite === true) {
			paths[`${item}/invites`] = {
				post: {
					operationId: `${entity.name}.invite`,
					parameters: itemParams,
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { key: { type: "string" } },
									required: ["key"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: {
						"201": {
							content: {
								"application/json": {
									schema: {
										properties: { grant_id: { type: "string" }, token: { type: "string" } },
										required: ["grant_id", "token"],
										type: "object",
									},
								},
							},
							description: "Invite created",
						},
						"400": error(400),
					},
					summary: `Invite another principal to read this ${entity.name}`,
					"x-entity": { action: "action", identity: entity.identity, name: entity.name },
					"x-invite": {
						accept: "invite.accept",
						grantPointer: "$.grant_id",
						granteeField: "key",
						invite: `${entity.name}.invite`,
						revoke: `${entity.name}.revoke`,
						tokenPointer: "$.token",
					},
					"x-tenant": "org_id",
				},
			}
			paths[`${item}/grants/{grant_id}`] = {
				delete: {
					operationId: `${entity.name}.revoke`,
					parameters: [
						...itemParams,
						{ in: "path", name: "grant_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { revoked: { type: "boolean" } },
										required: ["revoked"],
										type: "object",
									},
								},
							},
							description: "Revoked",
						},
						"404": error(404),
					},
					summary: "Revoke a grant",
					"x-entity": { action: "action", identity: entity.identity, name: entity.name },
					"x-tenant": "org_id",
				},
			}
		}
	}

	if (world.jobs === true) {
		const job = entityByName(world, "job")
		const start = "/v1/orgs/{org_id}/jobs/start"
		const poll = "/v1/orgs/{org_id}/jobs/{job_id}"
		paths[start] = {
			post: {
				operationId: "job.start",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				requestBody: {
					content: { "application/json": { schema: writeSchema(job, "create") } },
					required: true,
				},
				responses: {
					"202": ok(itemSchema(job), "Accepted"),
					"400": error(400),
					"415": error(415),
				},
				summary: "Start a job",
				"x-async": {
					idFrom: "$.id",
					poll: `GET ${poll}`,
					pollIntervalMs: 150,
					successWhen: "status.eq.complete",
					timeoutMs: 4000,
					until: "status.in.(complete,failed)",
				},
				"x-effects": [{ count: 1, entity: "artifact", op: "create" }],
				"x-entity": { action: "action", identity: job.identity, name: job.name },
				"x-tenant": "org_id",
			},
		}
	}

	if (world.entities.some((e) => e.invite === true)) {
		paths["/v1/invites/{token}/accept"] = {
			post: {
				operationId: "invite.accept",
				parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: { accepted: { type: "boolean" } },
									required: ["accepted"],
									type: "object",
								},
							},
						},
						description: "Accepted",
					},
					"404": error(404),
				},
				summary: "Accept an invite",
				"x-entity": {
					action: "action",
					identity: "id",
					name: world.entities.find((e) => e.invite === true)?.name ?? "entity",
				},
			},
		}
	}

	return {
		info: { title: world.title, version: "1.0" },
		openapi: "3.1.0",
		paths,
	}
}

function parentInvalidate(world: World, entity: Entity): string[] {
	if (entity.parent === undefined) return []
	const parent = entityByName(world, entity.parent)
	const derived = (parent.derived ?? []).some((d) => d.from === entity.name)
	if (!derived) return []
	return [`GET ${collectionPath(world, parent)}`, `GET ${itemPath(world, parent)}`]
}

function queryTag(world: World, entity: Entity): Json {
	const cols = allColumns(entity)
	const filterable = [
		"id",
		"org_id",
		...entity.fields.filter((f) => f.filterable === true).map((f) => f.name),
		"created_at",
		"updated_at",
	]
	if (world.defects?.includes("overclaim-filter")) filterable.push("ghost")
	const sortable = [
		"id",
		...entity.fields.filter((f) => f.sortable === true).map((f) => f.name),
		"created_at",
		"updated_at",
	]
	if (world.defects?.includes("overclaim-sort")) sortable.push("ghost")
	const searchable = entity.fields.filter((f) => f.searchable === true).map((f) => f.name)
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

function queryParams(world: World, entity: Entity): Json[] {
	const names = world.queryNames ?? {
		filter: "filter",
		limit: "limit",
		order: "order",
		search: "q",
		select: "select",
	}
	return [
		{ description: "PostgREST-style filter: field.op.value", in: "query", name: names.filter, schema: { type: "string" } },
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

function pathParams(world: World, entity: Entity, item: boolean): Json[] {
	const names = ["org_id", ...ancestors(world, entity).map((a) => `${a.name}_id`)]
	if (item) names.push(`${entity.name}_id`)
	return names.map((name) => ({ in: "path", name, required: true, schema: { type: "string" } }))
}

function itemSchema(entity: Entity): Json {
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
	if (entity.softDelete === true) properties.deleted_at = { type: ["integer", "null"] }
	return {
		properties,
		required: ["id", "org_id", ...entity.fields.filter((f) => f.required === true).map((f) => f.name), "created_at", "updated_at"],
		type: "object",
	}
}

function writeSchema(entity: Entity, phase: "create" | "update"): Json {
	const properties: Json = {}
	for (const field of entity.fields) {
		if (field.generated === true) continue
		properties[field.name] = fieldSchema(field)
	}
	return {
		properties,
		required: phase === "create" ? entity.fields.filter((f) => f.required === true).map((f) => f.name) : [],
		type: "object",
	}
}

function fieldSchema(field: { type: string; enum?: readonly string[]; maxLength?: number; nullable?: boolean }): Json {
	const type = field.nullable === true ? [field.type, "null"] : field.type
	const schema: Json = { type }
	if (field.enum !== undefined) schema.enum = [...field.enum]
	if (field.maxLength !== undefined) schema.maxLength = field.maxLength
	return schema
}

function generated(entity: Entity): string[] {
	const names = ["id", "org_id", "created_at", "updated_at"]
	if (entity.softDelete === true) names.push("deleted_at")
	for (const derived of entity.derived ?? []) names.push(derived.name)
	for (const field of entity.fields) {
		if (field.generated === true) names.push(field.name)
	}
	return names
}

function ok(schema: Json, description: string): Json {
	return { content: { "application/json": { schema } }, description }
}

function error(status: number): Json {
	return {
		content: {
			"application/json": {
				schema: {
					properties: { error_key: { type: "string" }, message: { type: "string" } },
					required: ["error_key", "message"],
					type: "object",
				},
			},
		},
		description: String(status),
	}
}
