/** Sharing a table with another principal: an invite, its acceptance, and revoking the grant. */

import type { EntityDef } from "../model.ts"
import { errorResponses } from "./errors.ts"
import { declaredIdentity, jsonResponse, ok } from "./operation.ts"
import { pathParams, tenantParam } from "./params.ts"
import type { Json, SpecContext } from "./types.ts"

function inviteOperation(ctx: SpecContext, table: EntityDef): Json {
	return {
		operationId: "table.invite",
		parameters: pathParams(ctx, table, true),
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
		"x-entity": { action: "action", identity: declaredIdentity(ctx, table), name: table.name },
		"x-invite": {
			accept: "invite.accept",
			grantPointer: "$.grant_id",
			granteeField: "key",
			invite: "table.invite",
			revoke: "table.revoke",
			tokenPointer: "$.token",
		},
		"x-tenant": tenantParam(table),
	}
}

function acceptOperation(ctx: SpecContext, table: EntityDef): Json {
	return {
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
		"x-entity": { action: "action", identity: declaredIdentity(ctx, table), name: table.name },
	}
}

function revokeOperation(ctx: SpecContext, table: EntityDef): Json {
	return {
		operationId: "table.revoke",
		parameters: [
			...pathParams(ctx, table, true),
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
		"x-entity": { action: "action", identity: declaredIdentity(ctx, table), name: table.name },
		"x-tenant": tenantParam(table),
	}
}

export function invitePaths(ctx: SpecContext, table: EntityDef): Json {
	return {
		[`${table.itemPath}/invites`]: { post: inviteOperation(ctx, table) },
		"/v1/invites/{token}/accept": { post: acceptOperation(ctx, table) },
		[`${table.itemPath}/grants/{grant_id}`]: { delete: revokeOperation(ctx, table) },
	}
}
