/** An entity's collection route: the listing and the create. */

import type { Dialect } from "../dialect/types.ts"
import type { EntityDef } from "../model/types.ts"
import { fieldsWhere } from "../model/fields.ts"
import { errorResponses } from "./errors.ts"
import { declaredIdentity, entityTag, jsonResponse, listResponseHeaders, ok } from "./operation.ts"
import { listQueryParams, pathParams, tenantParam } from "./params.ts"
import { queryDeclaration } from "./query.ts"
import { bodySchema, createdSchema, listLocated, listSchema, located } from "./schemas.ts"
import type { Json, SpecContext } from "./types.ts"

/**
 * Read routes belonging to an entity's parent, when a write here changes what they serve.
 *
 * Only the table/row relationship qualifies in this fixture: a table publishes `row_count`, so a
 * row write genuinely changes the table's representation. Declaring routes that a write does not
 * actually affect would make the invalidation check assert something false.
 */
export function parentReadRoutes(ctx: SpecContext, entity: EntityDef): string[] {
	if (entity.name !== "row") return []
	const table = ctx.entities.find((candidate) => candidate.name === "table")
	if (table === undefined) return []
	return [`GET ${table.collectionPath}`, `GET ${table.itemPath}`]
}

function listParameters(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json[] {
	return [
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
	]
}

function listOperation(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
	return {
		operationId: `${entity.name}.list`,
		parameters: listParameters(ctx, entity, dialect),
		responses: {
			[ok(ctx, 200)]: jsonResponse(
				`List ${entity.plural}`,
				listSchema(ctx, entity, dialect),
				listResponseHeaders(dialect),
			),
			...errorResponses(ctx, [400, 401, 403, 404]),
		},
		summary: `List ${entity.plural}`,
		tags: [entityTag(entity)],
		"x-entity": {
			action: "list",
			identity: declaredIdentity(ctx, entity),
			name: entity.name,
			...listLocated(ctx, entity, dialect),
		},
		"x-query": queryDeclaration(ctx, entity, dialect),
		/* Generous enough never to slow a run; declared so a stricter real limit is testable. */
		"x-rate-limit": { category: `${entity.name}.list`, rps: 500 },
		"x-tenant": tenantParam(entity),
		...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
	}
}

function createParameters(ctx: SpecContext, entity: EntityDef): Json[] {
	return [
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
	]
}

function createdResponse(ctx: SpecContext, entity: EntityDef): Json {
	if (ctx.shape.ackCreate === true && entity.name === "table") {
		return jsonResponse(`Created ${entity.name}`, {
			properties: { success: { type: "boolean" } },
			required: ["success"],
			type: "object",
		})
	}
	return jsonResponse(`Created ${entity.name}`, createdSchema(ctx, entity))
}

function createOperation(ctx: SpecContext, entity: EntityDef): Json {
	return {
		operationId: `${entity.name}.create`,
		parameters: createParameters(ctx, entity),
		requestBody: {
			content: {
				[ctx.shape.formCreate === true ? "application/x-www-form-urlencoded" : "application/json"]: {
					schema: bodySchema(entity, "create"),
				},
			},
			required: true,
		},
		responses: {
			[ok(ctx, 201)]: createdResponse(ctx, entity),
			...errorResponses(ctx, [400, 401, 403, 404, 409, 415]),
		},
		summary: `Create ${entity.name}`,
		tags: [entityTag(entity)],
		"x-entity": {
			action: "create",
			identity: declaredIdentity(ctx, entity),
			name: entity.name,
			...located(ctx, entity, "create"),
		},
		"x-generated": fieldsWhere(entity, "generated"),
		...(entity.unique === undefined || entity.unique.length === 0 ? {} : { "x-unique": entity.unique }),
		/*
		 * A create invalidates its own listing, and — where the entity has a parent that
		 * carries a derived value — the parent's routes as well. Declaring it is what makes
		 * the cross-entity consistency testable rather than assumed.
		 */
		"x-invalidate": [...listRoute(entity), ...parentReadRoutes(ctx, entity)],
		"x-tenant": tenantParam(entity),
	}
}

/** The entity's listing, as a route its writes change; none for an entity with no list. */
export function listRoute(entity: EntityDef): string[] {
	return entity.unlisted === true ? [] : [`GET ${entity.collectionPath}`]
}

/** The path item at an entity's collection route: its listing, unless it has none, and its create. */
export function collectionPathItem(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
	const create = { post: createOperation(ctx, entity) }
	return entity.unlisted === true ? create : { get: listOperation(ctx, entity, dialect), ...create }
}
