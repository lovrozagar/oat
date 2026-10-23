/** An entity's item route: the read, the update and the delete. */

import type { EntityDef } from "../model/types.ts"
import { fieldsWhere } from "../model/fields.ts"
import { listRoute, parentReadRoutes } from "./collection.ts"
import { errorResponses, preconditionResponses } from "./errors.ts"
import { declaredIdentity, entityTag, jsonResponse, ok } from "./operation.ts"
import { pathParams, tenantParam } from "./params.ts"
import { bodySchema, located, readSchema, writtenSchema } from "./schemas.ts"
import type { Json, SpecContext } from "./types.ts"

/** The routes an entity's own writes change: its listing, when it has one, and its item. */
function surface(entity: EntityDef): string[] {
	return [...listRoute(entity), `GET ${entity.itemPath}`]
}

/* The version a read answers, which an update's If-Match names. */
const ETAG: Json = { ETag: { description: "The record's version, a strong tag", schema: { type: "string" } } }

/* Optional, so an update that names no version is applied as before. */
const IF_MATCH: Json = {
	description: "Apply the update only while the record's ETag is one of these",
	in: "header",
	name: "If-Match",
	required: false,
	schema: { type: "string" },
}

function deleteOperation(ctx: SpecContext, entity: EntityDef): Json {
	return {
		operationId: `${entity.name}.delete`,
		parameters: pathParams(ctx, entity, true),
		responses: {
			[ok(ctx, 200)]: jsonResponse(`Deleted ${entity.name}`, writtenSchema(ctx, entity)),
			...errorResponses(ctx, [400, 401, 403, 404]),
		},
		summary: `Delete ${entity.name}`,
		tags: [entityTag(entity)],
		"x-entity": { action: "delete", identity: declaredIdentity(ctx, entity), name: entity.name },
		/* A delete changes the parent's derived count just as a create does. */
		"x-invalidate": [...surface(entity), ...parentReadRoutes(ctx, entity)],
		"x-tenant": tenantParam(entity),
		...(entity.softDeleteField === undefined ? {} : { "x-soft-delete": entity.softDeleteField }),
	}
}

function getOperation(ctx: SpecContext, entity: EntityDef): Json {
	return {
		operationId: `${entity.name}.get`,
		parameters: pathParams(ctx, entity, true),
		responses: {
			[ok(ctx, 200)]: jsonResponse(entity.name, readSchema(ctx, entity), ETAG),
			...errorResponses(ctx, [400, 401, 403, 404]),
		},
		summary: `Get ${entity.name}`,
		tags: [entityTag(entity)],
		"x-entity": {
			action: "read",
			identity: declaredIdentity(ctx, entity),
			name: entity.name,
			...located(ctx, entity, "read"),
		},
		"x-tenant": tenantParam(entity),
	}
}

function updateOperation(ctx: SpecContext, entity: EntityDef): Json {
	return {
		operationId: `${entity.name}.update`,
		parameters: [...pathParams(ctx, entity, true), IF_MATCH],
		requestBody: {
			content: {
				"application/json": { schema: bodySchema(entity, "update", ctx.shape.updateMethod === "PUT") },
			},
			required: true,
		},
		responses: {
			[ok(ctx, 200)]: jsonResponse(`Updated ${entity.name}`, writtenSchema(ctx, entity)),
			...errorResponses(ctx, [400, 401, 403, 404, 409, 415]),
			...preconditionResponses(),
		},
		summary: `Update ${entity.name}`,
		tags: [entityTag(entity)],
		"x-entity": { action: "update", identity: declaredIdentity(ctx, entity), name: entity.name },
		/* Declared here as well as on create. Real documents often list server-owned fields
		 * only where they are conspicuous — the fields a caller may not supply — and a tool
		 * that reads just one operation then treats a generated field as client-owned. */
		"x-generated": fieldsWhere(entity, "generated"),
		"x-immutable": entity.fields.filter((f) => f.immutable === true).map((f) => f.name),
		"x-invalidate": surface(entity),
		"x-tenant": tenantParam(entity),
	}
}

/** The path item at an entity's item route; the update is a PATCH, or a PUT under that shape. */
export function itemPathItem(ctx: SpecContext, entity: EntityDef): Json {
	return {
		delete: deleteOperation(ctx, entity),
		get: getOperation(ctx, entity),
		[ctx.shape.updateMethod === "PUT" ? "put" : "patch"]: updateOperation(ctx, entity),
	}
}
