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

function createKeyOperation(ctx: SpecContext): Json {
	const scopes = ctx.entities.flatMap((entity) => [`${entity.name}:read`, `${entity.name}:write`])
	return {
		operationId: "apiKey.create",
		requestBody: jsonBody({ scopes: { items: { enum: scopes, type: "string" }, type: "array" } }),
		responses: {
			[ok(ctx, 201)]: jsonResponse("The new key, shown once", fields({ id: STRING, key: STRING })),
			...errorResponses(ctx, [400, 401, 415]),
		},
		summary: "Mint an API key in the caller's tenant, holding the scopes named",
		tags: ["Auth"],
		"x-invalidate": KEY_READ,
	}
}

function revokeKeyOperation(ctx: SpecContext): Json {
	return {
		operationId: "apiKey.revoke",
		parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
		responses: {
			[ok(ctx, 200)]: jsonResponse("Revoked", fields({ revoked: { type: "boolean" } })),
			...errorResponses(ctx, [401, 404]),
		},
		summary: "Revoke an API key of the caller's tenant; it is gone after",
		tags: ["Auth"],
		"x-invalidate": KEY_READ,
	}
}

function readKeyOperation(ctx: SpecContext): Json {
	const key = fields({ id: STRING, scopes: { items: STRING, type: "array" } })
	return {
		operationId: "apiKey.get",
		parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
		responses: {
			[ok(ctx, 200)]: jsonResponse("A live key, without its value, which is shown only once", key),
			...errorResponses(ctx, [401, 404]),
		},
		summary: "Read a live API key of the caller's tenant",
		tags: ["Auth"],
	}
}

/** The sign-in operations, which need no credential, then revoking a token and the API key operations. */
export function authPaths(ctx: SpecContext): Json {
	return {
		"/v1/auth/token": { post: signIn(ctx, "auth.token", { key: STRING }) },
		"/v1/auth/login": { post: signIn(ctx, "auth.login", { email: STRING, password: STRING }) },
		"/v1/auth/refresh": { post: refreshOperation(ctx) },
		"/v1/auth/revoke": { post: revokeOperation(ctx) },
		"/v1/api-keys": { post: createKeyOperation(ctx) },
		"/v1/api-keys/{id}": { delete: revokeKeyOperation(ctx), get: readKeyOperation(ctx) },
	}
}
