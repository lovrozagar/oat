/** Routes about the caller: its profile, its own project, a register and a logout. */

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
		},
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
				properties: { access_token: { type: "string" } },
				required: ["access_token"],
				type: "object",
			}),
		},
		security: [],
		summary: "Register a caller",
		tags: ["Profile"],
		"x-fresh-principal": true,
	}
}

/** A read of the caller's own project, plus a register and a logout for the disposable user. */
export function callerRootPaths(ctx: SpecContext): Json {
	return {
		"/v1/logout": { post: logoutOperation(ctx) },
		"/v1/projects/{project_id}/overview": { get: overviewOperation(ctx) },
		"/v1/register": { post: registerOperation(ctx) },
	}
}
