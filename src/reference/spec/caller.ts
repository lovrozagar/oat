/** Routes about the caller: its profile, its account, its own project, a register and a logout. */

import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import type { Json, SpecContext } from "./types.ts"
import type { JsonSchema } from "../../spec/types.ts"

/** The signed-up caller is the record. No list, no create, no path id. */
export function callerProfilePaths(ctx: SpecContext): Json {
	const schema: JsonSchema = {
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
			delete: {
				operationId: "profile.delete",
				responses: {
					[ok(ctx, 204)]: { description: "The caller's account is gone" },
					...errorResponses(ctx, [401]),
				},
				summary: "Delete the signed-up caller's own account",
				tags: ["Profile"],
				"x-destructive": true,
				"x-entity": { action: "delete", identity: "self", name: "profile" },
				"x-invalidate": ["GET /v1/me"],
			},
		},
	}
}

/**
 * The caller's own account: the email and password it signs in with, and a display name. Untagged,
 * as many documents leave such a route: nothing marks it the caller's own but its path.
 */
function accountUpdateOperation(ctx: SpecContext): Json {
	return {
		operationId: "account.update",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: {
							display_name: { maxLength: 64, type: "string" },
							email: { format: "email", type: "string" },
							password: { minLength: 8, type: "string" },
						},
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			[ok(ctx, 200)]: jsonResponse("The caller's account", {
				additionalProperties: false,
				properties: { display_name: { type: "string" }, email: { type: "string" } },
				type: "object",
			}),
			...errorResponses(ctx, [400, 401]),
		},
		summary: "Update the caller's own account",
		tags: ["Profile"],
	}
}

function logoutOperation(ctx: SpecContext): Json {
	return {
		operationId: "auth.logout",
		responses: {
			[ok(ctx, 200)]: jsonResponse("Logged out", {
				additionalProperties: false,
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				type: "object",
			}),
			...errorResponses(ctx, [401]),
		},
		summary: "Log out this session",
		tags: ["Profile"],
		"x-destructive": true,
		"x-invalidate": ["GET /v1/me"],
	}
}

function overviewOperation(ctx: SpecContext): Json {
	return {
		operationId: "project.overview",
		parameters: [
			{
				in: "path",
				name: "project_id",
				required: true,
				schema: { type: "string" },
			},
		],
		responses: {
			[ok(ctx, 200)]: jsonResponse("The caller's project", {
				additionalProperties: false,
				properties: {
					extractions: { type: "integer" },
					project_id: { type: "string" },
				},
				required: ["extractions", "project_id"],
				type: "object",
			}),
			...errorResponses(ctx, [401]),
		},
		summary: "Read the caller's project",
		tags: ["Profile"],
		"x-entity": { action: "read", identity: "root", name: "overview" },
	}
}

function registerOperation(ctx: SpecContext): Json {
	return {
		operationId: "auth.register",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: { email: { format: "email", type: "string" } },
						required: ["email"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			[ok(ctx, 201)]: jsonResponse("A new caller", {
				additionalProperties: false,
				properties: { access_token: { type: "string" }, account_id: { type: "string" } },
				required: ["access_token", "account_id"],
				type: "object",
			}),
		},
		security: [],
		summary: "Register a caller",
		tags: ["Profile"],
		"x-entity": { action: "create", identity: "account_id", name: "signup" },
		"x-fresh-principal": true,
	}
}

/** An admin removing an account of its own project by id. */
function accountDeleteOperation(ctx: SpecContext): Json {
	return {
		operationId: "account.delete",
		parameters: [{ in: "path", name: "account_id", required: true, schema: { type: "string" } }],
		responses: {
			[ok(ctx, 204)]: { description: "The account is gone" },
			...errorResponses(ctx, [401, 403, 404]),
		},
		summary: "Delete an account of the caller's project",
		tags: ["Profile"],
		"x-entity": { action: "delete", identity: "account_id", name: "signup" },
	}
}

/**
 * A read of the caller's own project, its account, plus a register and a logout for the disposable
 * user, and an admin's delete of an account the register made.
 */
export function callerRootPaths(ctx: SpecContext): Json {
	return {
		"/v1/signups/{account_id}": { delete: accountDeleteOperation(ctx) },
		"/v1/logout": { post: logoutOperation(ctx) },
		"/v1/me/account": { put: accountUpdateOperation(ctx) },
		"/v1/projects/{project_id}/overview": { get: overviewOperation(ctx) },
		"/v1/register": { post: registerOperation(ctx) },
	}
}
