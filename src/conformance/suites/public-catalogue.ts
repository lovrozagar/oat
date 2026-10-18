import type { Handle } from "../../reference/http/node.ts"
import type { ReferenceRequest, ReferenceResponse } from "../../reference/http/wire.ts"

const PUBLIC_CATALOGUE_SPEC = {
	info: { title: "Public catalogue", version: "1.0" },
	openapi: "3.1.0",
	paths: {
		"/v1/templates": {
			get: {
				operationId: "template.list",
				parameters: [
					{
						description: "PostgREST filter expression, e.g. id.eq.value",
						in: "query",
						name: "filter",
						required: false,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										templates: {
											items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
											type: "array",
										},
									},
									required: ["templates"],
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "template" },
			},
			post: {
				operationId: "template.create",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								additionalProperties: false,
								properties: { name: { maxLength: 128, type: "string" } },
								required: ["name"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "created",
					},
				},
				"x-entity": { action: "create", identity: "id", name: "template" },
			},
		},
		"/v1/templates/{template_id}": {
			delete: {
				operationId: "template.delete",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "deleted" } },
				"x-entity": { action: "delete", identity: "id", name: "template" },
			},
			get: {
				operationId: "template.read",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "read", identity: "id", name: "template" },
			},
		},
	},
}

function send(status: number, body?: unknown): ReferenceResponse {
	if (body === undefined) return { body: "", headers: {}, status }
	const text = JSON.stringify(body)
	return {
		body: text,
		headers: { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" },
		status,
	}
}

/** A body read as JSON: nothing when empty, and a throw — answered 500 — when it is not JSON. */
async function readJson(request: ReferenceRequest): Promise<unknown> {
	const text = await request.text()
	return text === "" ? undefined : (JSON.parse(text) as unknown)
}

/**
 * A catalogue every principal reads in full: no tenant names its records, so a template one
 * principal made is the other's to read too. Answers each request, failures included.
 */
export function publicCatalogue(): Handle {
	const rows = new Map<string, { id: string; name: string }>()
	const tokens = new Set(["tok_alpha", "tok_beta"])
	let seq = 0
	const answer = async (request: ReferenceRequest): Promise<ReferenceResponse> => {
		const { method, url } = request
		if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(200, PUBLIC_CATALOGUE_SPEC)
		const header = request.headers.authorization ?? ""
		if (!header.startsWith("Bearer ") || !tokens.has(header.slice(7).trim()))
			return send(401, { error: "unauthorized" })
		if (url.pathname === "/v1/templates") {
			if (method === "GET") return send(200, { templates: listed(rows, url.searchParams.get("filter")) })
			if (method === "POST") {
				const body = (await readJson(request)) as { name?: unknown } | undefined
				seq += 1
				const row = { id: `tmpl_${String(seq)}`, name: typeof body?.name === "string" ? body.name : "" }
				rows.set(row.id, row)
				return send(201, row)
			}
		}
		return item(rows, request)
	}
	return async (request) => {
		try {
			return await answer(request)
		} catch {
			return send(500, { error: "internal" })
		}
	}
}

/* Every template, or the one `filter=id.eq.<id>` names. */
function listed(rows: ReadonlyMap<string, { id: string; name: string }>, filter: string | null): unknown[] {
	const match = filter === null ? null : /^id\.eq\.(.+)$/.exec(filter)
	if (match === null) return [...rows.values()]
	const row = rows.get(match[1] ?? "")
	return row === undefined ? [] : [row]
}

function item(rows: Map<string, { id: string; name: string }>, request: ReferenceRequest): ReferenceResponse {
	const match = /^\/v1\/templates\/([^/]+)$/.exec(request.url.pathname)
	if (match === null || (request.method !== "GET" && request.method !== "DELETE"))
		return send(404, { error: "not_found" })
	const id = decodeURIComponent(match[1] ?? "")
	const row = rows.get(id)
	if (row === undefined) return send(404, { error: "not_found" })
	if (request.method === "GET") return send(200, row)
	rows.delete(id)
	return send(204)
}
