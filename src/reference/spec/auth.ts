/** Signing in and API keys: the token, login, refresh and revoke operations, and minting and revoking keys. */

import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import type { Json, SpecContext } from "./types.ts"

/* An object of exactly these fields, every one required. */
function fields(properties: Json): Json {
	return { additionalProperties: false, properties, required: Object.keys(properties), type: "object" }
}

const STRING = { type: "string" }

/* The one route a key is read back through, which minting and revoking it change. */
const KEY_READ = ["GET /v1/api-keys/{id}"]

function jsonBody(properties: Json): Json {
	return { content: { "application/json": { schema: fields(properties) } }, required: true }
}

/* What a sign-in, or a refresh, answers. */
const session = (): Json =>
	fields({ access_token: STRING, refresh_token: STRING, expires_in: { type: "integer" }, project_id: STRING })

/* The throttle's answer: when to try again. */
const THROTTLED: Json = {
	description: "Too many failed logins",
	headers: { "Retry-After": { description: "Seconds until a login is tried again", schema: { type: "integer" } } },
}

/* A public sign-in: `body` for a JWT pair, throttled once one identity keeps failing. */
function signIn(ctx: SpecContext, id: string, body: Json): Json {
	return {
		operationId: id,
		requestBody: jsonBody(body),
		responses: {
			[ok(ctx, 200)]: jsonResponse("A JWT pair", session()),
			...errorResponses(ctx, [400, 401, 415]),
			429: THROTTLED,
		},
		security: [],
		summary: id === "auth.token" ? "Exchange an API key for a JWT pair" : "Sign in with email and password",
		tags: ["Auth"],
	}
}

function refreshOperation(ctx: SpecContext): Json {
	return {
		operationId: "auth.refresh",
		requestBody: jsonBody({ refresh_token: STRING }),
		responses: { [ok(ctx, 200)]: jsonResponse("A new JWT pair", session()), ...errorResponses(ctx, [400, 401, 415]) },
		security: [],
		summary: "Rotate a refresh token; reusing a rotated one revokes its session",
		tags: ["Auth"],
	}
}

function revokeOperation(ctx: SpecContext): Json {
	return {
		operationId: "auth.revoke",
		requestBody: jsonBody({ token: STRING }),
		responses: {
			[ok(ctx, 200)]: jsonResponse("Revoked", fields({ revoked: { type: "boolean" } })),
			...errorResponses(ctx, [400, 401, 403, 415]),
		},
		summary: "Revoke one of the caller's access or refresh tokens",
		tags: ["Auth"],
	}
}

/* Under key-lifecycle, the key operations are the api-key entity's own, each key its tenant's by its id. */
function keyTags(ctx: SpecContext, action: string, scoped: boolean): Json {
	if (ctx.shape.keyLifecycle !== true) return {}
	const entity = { "x-entity": { action, identity: "id", name: "api-key" } }
	return scoped ? { ...entity, "x-tenant": "id" } : entity
}

/* The routes a key's create, rename and revoke change: its read, and its listing behind key-lifecycle. */
function keyRoutes(ctx: SpecContext): string[] {
	return ctx.shape.keyLifecycle === true ? [...KEY_READ, "GET /v1/api-keys"] : KEY_READ
}

/* A key as it is read back, never with its value: named behind key-lifecycle. */
function keyRecord(ctx: SpecContext): Json {
	const named = ctx.shape.keyLifecycle === true ? { name: { type: ["string", "null"] } } : {}
	return fields({ id: STRING, ...named, scopes: { items: STRING, type: "array" } })
}

function createKeyOperation(ctx: SpecContext): Json {
	const scopes = ctx.entities.flatMap((entity) => [`${entity.name}:read`, `${entity.name}:write`])
	const scopeList = { items: { enum: scopes, type: "string" }, type: "array" }
	const body =
		ctx.shape.keyLifecycle === true
			? {
					content: {
						"application/json": {
							schema: {
								additionalProperties: false,
								properties: { name: STRING, scopes: scopeList },
								required: ["scopes"],
								type: "object",
							},
						},
					},
					required: true,
				}
			: jsonBody({ scopes: scopeList })
	return {
		operationId: "apiKey.create",
		requestBody: body,
		responses: {
			[ok(ctx, 201)]: jsonResponse("The new key, shown once", fields({ id: STRING, key: STRING })),
			...errorResponses(ctx, [400, 401, 415]),
		},
		summary: "Mint an API key in the caller's tenant, holding the scopes named",
		tags: ["Auth"],
		"x-invalidate": keyRoutes(ctx),
		...keyTags(ctx, "create", false),
	}
}

function revokeKeyOperation(ctx: SpecContext): Json {
	return {
		operationId: "apiKey.revoke",
		parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
		responses: {
			[ok(ctx, 200)]: jsonResponse("Revoked", fields({ revoked: { type: "boolean" } })),
			...errorResponses(ctx, [401, 403, 404]),
		},
		summary: "Revoke an API key of the caller's tenant, its own or, for the tenant's admin, any; it is gone after",
		tags: ["Auth"],
		"x-invalidate": keyRoutes(ctx),
		...keyTags(ctx, "delete", true),
	}
}

function readKeyOperation(ctx: SpecContext): Json {
	return {
		operationId: "apiKey.get",
		parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
		responses: {
			[ok(ctx, 200)]: jsonResponse("A live key, without its value, which is shown only once", keyRecord(ctx)),
			...errorResponses(ctx, [401, 404]),
		},
		summary: "Read a live API key of the caller's tenant",
		tags: ["Auth"],
		...keyTags(ctx, "read", true),
	}
}

/* Behind key-lifecycle: the caller's tenant's live keys. */
function listKeysOperation(ctx: SpecContext): Json {
	return {
		operationId: "apiKey.list",
		responses: {
			[ok(ctx, 200)]: jsonResponse("The caller's tenant's live keys", { items: keyRecord(ctx), type: "array" }),
			...errorResponses(ctx, [401]),
		},
		summary: "List the live API keys of the caller's tenant",
		tags: ["Auth"],
		...keyTags(ctx, "list", false),
	}
}

/* Behind key-lifecycle: rename a key, its creator's or, for the tenant's admin, any. */
function renameKeyOperation(ctx: SpecContext): Json {
	return {
		operationId: "apiKey.update",
		parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
		requestBody: jsonBody({ name: STRING }),
		responses: {
			[ok(ctx, 200)]: jsonResponse("The renamed key", keyRecord(ctx)),
			...errorResponses(ctx, [400, 401, 403, 404, 415]),
		},
		summary: "Rename an API key of the caller's tenant",
		tags: ["Auth"],
		"x-invalidate": keyRoutes(ctx),
		...keyTags(ctx, "update", true),
	}
}

/** The sign-in operations, which need no credential, then revoking a token and the API key operations. */
export function authPaths(ctx: SpecContext): Json {
	return {
		"/v1/auth/token": { post: signIn(ctx, "auth.token", { key: STRING }) },
		"/v1/auth/login": { post: signIn(ctx, "auth.login", { email: STRING, password: STRING }) },
		"/v1/auth/refresh": { post: refreshOperation(ctx) },
		"/v1/auth/revoke": { post: revokeOperation(ctx) },
		"/v1/api-keys":
			ctx.shape.keyLifecycle === true
				? { get: listKeysOperation(ctx), post: createKeyOperation(ctx) }
				: { post: createKeyOperation(ctx) },
		"/v1/api-keys/{id}":
			ctx.shape.keyLifecycle === true
				? { delete: revokeKeyOperation(ctx), get: readKeyOperation(ctx), patch: renameKeyOperation(ctx) }
				: { delete: revokeKeyOperation(ctx), get: readKeyOperation(ctx) },
	}
}
