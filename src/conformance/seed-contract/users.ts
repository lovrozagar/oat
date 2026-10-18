/**
 * A register-and-login API: `auth.registerWithEmail` provisions the principal through its auth
 * steps, so it must never also be seeded as a fixture create.
 */

import type { Handle } from "../../reference/http/node.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"

function register(): Record<string, unknown> {
	const user = {
		properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
		required: ["id", "email"],
		type: "object",
	}
	return {
		operationId: "auth.registerWithEmail",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						properties: { email: { format: "email", type: "string" }, password: { type: "string" } },
						required: ["email", "password"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			"201": { content: { "application/json": { schema: user } }, description: "created" },
		},
		"x-entity": { action: "create", identity: "id", name: "user" },
		"x-fresh-principal": true,
	}
}

function login(): Record<string, unknown> {
	return {
		operationId: "auth.login",
		requestBody: {
			content: {
				"application/json": {
					schema: { properties: { email: { type: "string" }, password: { type: "string" } }, type: "object" },
				},
			},
		},
		responses: {
			"200": {
				content: {
					"application/json": {
						schema: {
							properties: { access_token: { type: "string" } },
							required: ["access_token"],
							type: "object",
						},
					},
				},
				description: "ok",
			},
		},
	}
}

export function userSpec(): OpenApiDocument {
	return {
		info: { title: "register-is-not-seed", version: "1" },
		openapi: "3.1.0",
		paths: { "/v1/auth/register": { post: register() }, "/v1/auth/login": { post: login() } },
	} as OpenApiDocument
}

/** The user API, and who each register call came from: the auth steps (`auth`) or anything else. */
export interface UserBackend {
	handle: Handle
	registerFrom: string[]
}

export function userBackend(): UserBackend {
	const spec = userSpec()
	const registerFrom: string[] = []
	const handle: Handle = async (request) => {
		const { pathname } = request.url
		const { method } = request
		if (pathname === "/v1/openapi/spec" && method === "GET") return answer(200, spec)
		if (pathname === "/v1/auth/register" && method === "POST") {
			registerFrom.push(request.headers["x-via"] === "auth" ? "auth" : "other")
			const body = (await readJson(request)) as { email?: unknown } | undefined
			if (typeof body?.email === "string" && !body.email.includes("@")) return answer(400, { error: "invalid email" })
			return answer(201, { email: body?.email, id: "u1" })
		}
		if (pathname === "/v1/auth/login" && method === "POST") return answer(200, { access_token: "tok" })
		return answer(404)
	}
	return { handle: guarded(handle), registerFrom }
}
