/** A project API whose `extract.once` is paid inference: `--profile cheap` must never POST it. */

import type { Handle } from "../../reference/http/node.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { bearerSecurity } from "../harness/security.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"

const PROJECT = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const PROJECT_ID = { in: "path", name: "project_id", required: true, schema: { type: "string" } }

function collection(): Record<string, unknown> {
	return {
		get: {
			operationId: "project.list",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								properties: { projects: { items: PROJECT, type: "array" } },
								required: ["projects"],
								type: "object",
							},
						},
					},
					description: "ok",
				},
			},
			"x-entity": { action: "list", identity: "id", name: "project" },
		},
		post: {
			operationId: "project.create",
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
					},
				},
				required: true,
			},
			responses: {
				"201": { content: { "application/json": { schema: PROJECT } }, description: "created" },
			},
			"x-entity": { action: "create", identity: "id", name: "project" },
		},
	}
}

function extract(): Record<string, unknown> {
	return {
		post: {
			operationId: "extract.once",
			parameters: [PROJECT_ID],
			responses: {
				"200": { content: { "application/json": { schema: PROJECT } }, description: "ok" },
				"500": { description: "paid inference failed" },
			},
			"x-cost": "high",
			"x-effects": [{ entity: "project", op: "update" }],
			"x-entity": { action: "action", identity: "id", name: "project" },
		},
	}
}

export function projectSpec(): OpenApiDocument {
	return {
		info: { title: "cheap-effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects": collection(),
			"/v1/projects/{project_id}": {
				get: {
					operationId: "project.read",
					parameters: [PROJECT_ID],
					responses: { "200": { content: { "application/json": { schema: PROJECT } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "project" },
				},
			},
			"/v1/projects/{project_id}/extract": extract(),
		},
		...bearerSecurity(),
	} as OpenApiDocument
}

/** The project API, and how many times its paid extract was invoked. */
export interface ProjectBackend {
	handle: Handle
	extractHits: () => number
}

export function projectBackend(): ProjectBackend {
	const spec = projectSpec()
	const rows = new Map<string, { id: string; name: string }>()
	let seq = 0
	let extractHits = 0
	const handle: Handle = async (request) => {
		const { pathname } = request.url
		const { method } = request
		if (pathname === "/v1/openapi/spec" && method === "GET") return answer(200, spec)
		if (pathname === "/v1/projects" && method === "GET") return answer(200, { projects: [...rows.values()] })
		if (pathname === "/v1/projects" && method === "POST") {
			const body = (await readJson(request)) as { name?: unknown } | undefined
			seq += 1
			const id = `p_${String(seq)}`
			const row = { id, name: typeof body?.name === "string" ? body.name : "n" }
			rows.set(id, row)
			return answer(201, row)
		}
		if (/^\/v1\/projects\/[^/]+$/.test(pathname) && method === "GET") {
			const row = rows.get(decodeURIComponent(pathname.slice("/v1/projects/".length)))
			return row === undefined ? answer(404) : answer(200, row)
		}
		if (/^\/v1\/projects\/[^/]+\/extract$/.test(pathname) && method === "POST") {
			extractHits += 1
			return answer(500, { error: "paid inference" })
		}
		return answer(404)
	}
	return { extractHits: () => extractHits, handle: guarded(handle) }
}
