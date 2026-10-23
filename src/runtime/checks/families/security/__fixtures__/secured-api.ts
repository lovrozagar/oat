import type { OpenApiDocument } from "../../../../../spec/types.ts"

/*
 * A small secured API: jwt sessions issued by a login, refreshed and revoked, and API keys behind a
 * scope. Notes live under a project; reads take jwt OR a notes:read key, writes jwt OR notes:write.
 * `verified` is marked `x-privileged`. Two reads qualify as a lifecycle check's route: the feed
 * first in document order, then the notes list, so a test can show a list outranks it.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = { "200": { description: "ok", ...json({ type: "object" }) } }
const refusals = { "401": { description: "no credential" }, "403": { description: "forbidden" } }
const reads = [{ jwt: [] }, { apiKey: ["notes:read"] }]
const writes = [{ jwt: [] }, { apiKey: ["notes:write"] }]
const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const noteId = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
const keyId = { in: "path", name: "key_id", required: true, schema: { type: "string" } }
const note = {
	properties: {
		id: { readOnly: true, type: "string" },
		title: { type: "string" },
		verified: { type: "boolean", "x-privileged": true },
	},
	type: "object",
}
const login = {
	properties: { email: { format: "email", type: "string" }, password: { minLength: 8, type: "string" } },
	required: ["email", "password"],
	type: "object",
}

/** The secured notes document; `extra` paths are merged in. */
export function securedDoc(extra: Record<string, unknown> = {}): OpenApiDocument {
	return {
		components: {
			securitySchemes: {
				apiKey: { in: "header", name: "Authorization", type: "apiKey" },
				jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		},
		info: { title: "secured", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/api-keys/{key_id}": {
				delete: { operationId: "apiKey.revoke", parameters: [keyId], responses: { "204": { description: "gone" } } },
			},
			"/auth/login": {
				post: {
					operationId: "auth.login",
					requestBody: { required: true, ...json(login) },
					responses: { ...ok, "401": { description: "bad login" }, "429": { description: "slow down" } },
					security: [],
				},
			},
			"/auth/refresh": { post: { operationId: "auth.refresh", responses: ok, security: [] } },
			"/auth/revoke": { post: { operationId: "auth.revoke", responses: ok } },
			"/health": { get: { operationId: "gateway.health", responses: ok, security: [] } },
			"/projects/{project_id}/feed": {
				get: { operationId: "feed.list", parameters: [project], responses: { ...ok, ...refusals }, security: reads },
			},
			"/projects/{project_id}/notes": {
				get: { operationId: "notes.list", parameters: [project], responses: { ...ok, ...refusals }, security: reads },
			},
			"/projects/{project_id}/notes/{note_id}": {
				delete: {
					operationId: "notes.delete",
					parameters: [project, noteId],
					responses: { "204": { description: "gone" }, ...refusals },
					security: writes,
				},
				get: {
					operationId: "notes.get",
					parameters: [project, noteId],
					responses: { "200": { description: "ok", ...json(note) }, ...refusals },
					security: reads,
				},
				patch: {
					operationId: "notes.update",
					parameters: [project, noteId],
					requestBody: { required: true, ...json(note) },
					responses: { "200": { description: "ok", ...json(note) }, ...refusals },
					security: writes,
				},
			},
			...extra,
		},
		security: [{ jwt: [] }],
	} as unknown as OpenApiDocument
}

/* An operation without its own security. */
function strip(operation: Record<string, unknown>): Record<string, unknown> {
	const { security: _security, ...rest } = operation
	return rest
}

/** The secured document with no security declared anywhere: what an overlay must fill. */
export function undeclaredDoc(): OpenApiDocument {
	const {
		components: _components,
		security: _security,
		paths,
		...doc
	} = securedDoc() as unknown as {
		components: unknown
		security: unknown
		paths: Record<string, Record<string, Record<string, unknown>>>
	}
	const open = Object.fromEntries(
		Object.entries(paths).map(([path, item]) => [
			path,
			Object.fromEntries(Object.entries(item).map(([method, operation]) => [method, strip(operation)])),
		]),
	)
	return { ...doc, paths: open } as unknown as OpenApiDocument
}

/** The run-created note a write probe may target, owned by alpha in proj_a. */
export const NOTE_TARGET = {
	current: { id: "n1", title: "first", verified: false },
	entity: "note",
	id: "n1",
	owner: "alpha",
	params: { note_id: "n1", project_id: "proj_a" },
	path: "/projects/proj_a/notes/n1",
} as const
