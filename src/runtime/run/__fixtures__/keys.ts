import type { SecurityConfig } from "../../../config/types/security.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Responder } from "../../checks/__fixtures__/harness.ts"
import { notesApi, notesDoc } from "./api.ts"

/*
 * Minted project keys: the notes API where alpha's bearer token mints an API key for project p1,
 * an operation only a key opens turns the first key away, and an OAuth 2 token URL issues a token.
 */

const projectParam = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const ok = { "200": { description: "ok" } }

/** The notes document with minted project keys, an operation only a key opens, and an OAuth 2 token URL. */
export function keysDoc(): OpenApiDocument {
	const doc = notesDoc({
		"/projects/{project_id}/keys": {
			post: { operationId: "keys.create", parameters: [projectParam], responses: { "201": { description: "made" } } },
		},
		"/projects/{project_id}/keys/{id}": {
			delete: {
				operationId: "keys.revoke",
				parameters: [projectParam, { in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "gone" } },
			},
		},
		"/secure": { get: { operationId: "secure.get", responses: ok, security: [{ key: [] }] } },
		"/granted": { get: { operationId: "granted.get", responses: ok, security: [{ oauth: [] }] } },
	}) as unknown as { components: { securitySchemes: Record<string, unknown> } }
	doc.components.securitySchemes.key = { in: "header", name: "x-api-key", type: "apiKey" }
	doc.components.securitySchemes.oauth = {
		flows: { clientCredentials: { scopes: {}, tokenUrl: "http://api.test/token" } },
		type: "oauth2",
	}
	return doc as unknown as OpenApiDocument
}

/** Alpha's static bearer token, the key it mints with it, and an OAuth 2 client. */
export const MINTED: SecurityConfig = {
	bearer: { static: "alpha-key" },
	key: {
		mint: { body: { label: "oat" }, from: "$.key", operationId: "keys.create", revoke: "keys.revoke", with: "bearer" },
	},
	oauth: { oauth2: { clientId: "client-1", clientSecret: "shh", flow: "clientCredentials" } },
}

/** Mints `k<n>` for project p1, turns `k1` away, revokes with `revoke`, and issues an OAuth 2 token. */
export function keysApi(revoke = 204): Responder {
	const doc = keysDoc()
	const notes = notesApi(doc)
	let minted = 0
	return (method, path, request) => {
		if (path === "/projects/p1/keys" && method === "POST") {
			minted += 1
			return { body: { id: minted, key: `k${minted}` }, status: 201 }
		}
		if (path.startsWith("/projects/p1/keys/") && method === "DELETE") return { status: revoke }
		if (path === "/secure") return { status: request.headers?.["x-api-key" as never] === "k1" ? 401 : 200 }
		if (path === "/token") return { body: { access_token: "granted-1" }, status: 200 }
		if (path === "/granted") return { status: 200 }
		return notes(method, path, request)
	}
}
