import {
	error,
	generated,
	itemSchema,
	keyBody,
	objectSchema,
	ok,
	pathParam,
	pathParams,
	queryParams,
	queryTag,
	writeSchema,
	type Json,
} from "./spec-schema.ts"
import { collectionPath, entityByName, itemPath, type Entity, type World } from "./types.ts"

/** One entity's routes and the pieces its operations share. */
interface Routes {
	world: World
	entity: Entity
	list: string
	item: string
	surface: string[]
	parentRoutes: string[]
	params: Json[]
	itemParams: Json[]
}

export function buildSpec(world: World): Json {
	const paths: Json = { "/v1/auth/token": { post: authOperation() } }
	for (const entity of world.entities) Object.assign(paths, entityPaths(routesOf(world, entity)))
	if (world.jobs === true) paths["/v1/orgs/{org_id}/jobs/start"] = { post: jobStartOperation(world) }
	if (world.entities.some((e) => e.invite === true)) {
		paths["/v1/invites/{token}/accept"] = { post: acceptOperation(world) }
	}
	return {
		info: { title: world.title, version: "1.0" },
		openapi: "3.1.0",
		paths,
		/* The bearer token auth.token issues, which every other route wants (http.ts `authenticate`). */
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		security: [{ bearer: [] }],
	}
}

function routesOf(world: World, entity: Entity): Routes {
	const list = collectionPath(world, entity)
	const item = itemPath(world, entity)
	return {
		entity,
		item,
		itemParams: pathParams(world, entity, true),
		list,
		params: pathParams(world, entity, false),
		parentRoutes: parentInvalidate(world, entity),
		surface: [`GET ${list}`, `GET ${item}`],
		world,
	}
}

function entityPaths(routes: Routes): Json {
	const { entity, item, list } = routes
	const paths: Json = {
		[list]: { get: listOperation(routes), post: createOperation(routes) },
		[item]: { delete: deleteOperation(routes), get: readOperation(routes), patch: updateOperation(routes) },
	}
	if (entity.invite === true) {
		paths[`${item}/invites`] = { post: inviteOperation(routes) }
		paths[`${item}/grants/{grant_id}`] = { delete: revokeOperation(routes) }
	}
	return paths
}

function authOperation(): Json {
	return {
		operationId: "auth.token",
		requestBody: keyBody(),
		responses: {
			"200": ok(
				objectSchema({ access_token: { type: "string" }, org_id: { type: "string" } }, ["access_token", "org_id"]),
				"Credential",
			),
			"401": error(401),
		},
		security: [],
		summary: "Exchange an API key for a bearer token",
	}
}

function entityTag(entity: Entity, action: string): Json {
	return { action, identity: entity.identity, name: entity.name }
}

function listOperation({ entity, params, world }: Routes): Json {
	const page = objectSchema(
		{
			[entity.plural]: { items: itemSchema(entity), type: "array" },
			count: { type: "integer" },
			hasMore: { type: "boolean" },
			limit: { type: "integer" },
			nextCursor: { type: ["string", "null"] },
			page: { type: "integer" },
		},
		[entity.plural, "count", "hasMore"],
	)
	return {
		operationId: `${entity.name}.list`,
		parameters: [...params, ...queryParams(world, entity)],
		responses: { "200": ok(page, `A page of ${entity.plural}`), "400": error(400) },
		summary: `List ${entity.plural}`,
		"x-entity": entityTag(entity, "list"),
		"x-query": queryTag(world, entity),
		"x-tenant": "org_id",
	}
}

function createOperation({ entity, list, params, parentRoutes }: Routes): Json {
	return {
		operationId: `${entity.name}.create`,
		parameters: [...params, { in: "header", name: "Idempotency-Key", required: false, schema: { type: "string" } }],
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
		"x-entity": entityTag(entity, "create"),
		"x-generated": generated(entity),
		"x-invalidate": [`GET ${list}`, ...parentRoutes],
		"x-tenant": "org_id",
	}
}

function deleteOperation({ entity, itemParams, parentRoutes, surface }: Routes): Json {
	return {
		operationId: `${entity.name}.delete`,
		parameters: itemParams,
		responses: { "204": { description: "Deleted" }, "404": error(404) },
		summary: `Delete ${entity.name}`,
		"x-entity": entityTag(entity, "delete"),
		"x-invalidate": [...surface, ...parentRoutes],
		"x-tenant": "org_id",
		...(entity.softDelete === true ? { "x-soft-delete": "deleted_at" } : {}),
	}
}

function readOperation({ entity, itemParams }: Routes): Json {
	return {
		operationId: `${entity.name}.get`,
		parameters: itemParams,
		responses: { "200": ok(itemSchema(entity), entity.name), "404": error(404) },
		summary: `Read ${entity.name}`,
		"x-entity": entityTag(entity, "read"),
		"x-tenant": "org_id",
	}
}

function updateOperation({ entity, itemParams, parentRoutes, surface }: Routes): Json {
	return {
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
		"x-entity": entityTag(entity, "update"),
		"x-generated": generated(entity),
		"x-immutable": ["id", "org_id", "created_at"],
		"x-invalidate": [...surface, ...parentRoutes],
		"x-tenant": "org_id",
	}
}

function inviteOperation({ entity, itemParams }: Routes): Json {
	return {
		operationId: `${entity.name}.invite`,
		parameters: itemParams,
		requestBody: keyBody(),
		responses: {
			"201": ok(
				objectSchema({ grant_id: { type: "string" }, token: { type: "string" } }, ["grant_id", "token"]),
				"Invite created",
			),
			"400": error(400),
		},
		summary: `Invite another principal to read this ${entity.name}`,
		"x-entity": entityTag(entity, "action"),
		"x-invite": {
			accept: "invite.accept",
			grantPointer: "$.grant_id",
			granteeField: "key",
			invite: `${entity.name}.invite`,
			revoke: `${entity.name}.revoke`,
			tokenPointer: "$.token",
		},
		"x-tenant": "org_id",
	}
}

function revokeOperation({ entity, itemParams }: Routes): Json {
	return {
		operationId: `${entity.name}.revoke`,
		parameters: [...itemParams, pathParam("grant_id")],
		responses: {
			"200": ok(objectSchema({ revoked: { type: "boolean" } }, ["revoked"]), "Revoked"),
			"404": error(404),
		},
		summary: "Revoke a grant",
		"x-entity": entityTag(entity, "action"),
		"x-tenant": "org_id",
	}
}

function jobStartOperation(world: World): Json {
	const job = entityByName(world, "job")
	return {
		operationId: "job.start",
		parameters: [pathParam("org_id")],
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
			poll: "GET /v1/orgs/{org_id}/jobs/{job_id}",
			pollIntervalMs: 150,
			successWhen: "status.eq.complete",
			timeoutMs: 4000,
			until: "status.in.(complete,failed)",
		},
		"x-effects": [{ count: 1, entity: "artifact", op: "create" }],
		"x-entity": entityTag(job, "action"),
		"x-tenant": "org_id",
	}
}

function acceptOperation(world: World): Json {
	return {
		operationId: "invite.accept",
		parameters: [pathParam("token")],
		responses: {
			"200": ok(objectSchema({ accepted: { type: "boolean" } }, ["accepted"]), "Accepted"),
			"404": error(404),
		},
		summary: "Accept an invite",
		"x-entity": {
			action: "action",
			identity: "id",
			name: world.entities.find((e) => e.invite === true)?.name ?? "entity",
		},
	}
}

function parentInvalidate(world: World, entity: Entity): string[] {
	if (entity.parent === undefined) return []
	const parent = entityByName(world, entity.parent)
	const derived = (parent.derived ?? []).some((d) => d.from === entity.name)
	if (!derived) return []
	return [`GET ${collectionPath(world, parent)}`, `GET ${itemPath(world, parent)}`]
}
