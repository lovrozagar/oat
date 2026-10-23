import type { SecurityConfig } from "../../../config/types/security.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import { notesApi, notesDoc } from "./api.ts"

/*
 * Minted project keys: the notes API where alpha's bearer token mints an API key for project p1,
 * an operation only a key opens turns the first key away, and an OAuth 2 token URL issues a token.
 */

const projectParam = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const ok = { "200": { description: "ok" } }

const keyParams = [projectParam, { in: "path", name: "id", required: true, schema: { type: "string" } }]

/**
 * The notes document with minted project keys, an operation only a key opens, and an OAuth 2 token
 * URL. `readable` documents a read of each key.
 */
export function keysDoc({ readable = false }: { readable?: boolean } = {}): OpenApiDocument {
	const read = { get: { operationId: "keys.get", parameters: keyParams, responses: ok } }
	const doc = notesDoc({
		"/projects/{project_id}/keys": {
			post: { operationId: "keys.create", parameters: [projectParam], responses: { "201": { description: "made" } } },
		},
		"/projects/{project_id}/keys/{id}": {
			delete: { operationId: "keys.revoke", parameters: keyParams, responses: { "204": { description: "gone" } } },
			...(readable ? read : {}),
		},
		"/secure": { get: { operationId: "secure.get", responses: ok, security: [{ key: [] }] } },
		"/granted": { get: { operationId: "granted.get", responses: ok, security: [{ oauth: [] }] } },
	}) as unknown as { components: { securitySchemes: Record<string, unknown> } }
	doc.components.securitySchemes["key"] = { in: "header", name: "x-api-key", type: "apiKey" }
	doc.components.securitySchemes["oauth"] = {
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

/**
 * Mints `k<n>` (id n) for project p1, turns `k1` away, revokes with `revoke`, and issues an OAuth 2
 * token. A key already deleted answers its DELETE 400; `readable` reads a held key 200 and any other 404.
 */
export function keysApi(revoke = 204, { readable = false }: { readable?: boolean } = {}): Responder {
	const doc = keysDoc({ readable })
	const notes = notesApi(doc)
	const keys = projectKeys(revoke, readable)
	return (method, path, request) => {
		const answer = keys(method, path)
		if (answer !== undefined) return answer
		if (path === "/secure") return { status: request.headers?.["x-api-key" as never] === "k1" ? 401 : 200 }
		if (path === "/token") return { body: { access_token: "granted-1" }, status: 200 }
		if (path === "/granted") return { status: 200 }
		return notes(method, path, request)
	}
}

/* Project p1's keys, as held: minted, deleted once, and read when `readable`. */
function projectKeys(revoke: number, readable: boolean): (method: string, path: string) => Answer | undefined {
	const held = new Set<string>()
	let minted = 0
	return (method, path) => {
		if (path === "/projects/p1/keys" && method === "POST") {
			minted += 1
			held.add(String(minted))
			return { body: { id: minted, key: `k${minted}` }, status: 201 }
		}
		const key = /^\/projects\/p1\/keys\/([^/]+)$/.exec(path)?.[1]
		if (key === undefined) return undefined
		if (method === "DELETE") {
			if (!held.has(key)) return { status: 400 }
			if (revoke < 300) held.delete(key)
			return { status: revoke }
		}
		return readable && method === "GET" ? { status: held.has(key) ? 200 : 404 } : undefined
	}
}
