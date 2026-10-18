/** The effects suite's document: tables in a project, their rows, and one extract that makes both. */

import type { OpenApiDocument } from "../../spec/types.ts"

const TABLE = {
	properties: { id: { type: "string" }, name: { type: "string" }, table_id: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const ROW = {
	properties: { id: { type: "string" }, table_id: { type: "string" } },
	required: ["id", "table_id"],
	type: "object",
}

const json = (schema: object) => ({ content: { "application/json": { schema } } })
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
const entity = (action: string, name: string) => ({ "x-entity": { action, identity: "id", name } })

/** A 200 whose body lists `items` of `item` under `key`. */
function listed(key: string, item: object) {
	return {
		"200": {
			...json({ properties: { [key]: { items: item, type: "array" } }, required: [key], type: "object" }),
			description: "ok",
		},
	}
}

const PROJECT = [/* @__PURE__ */ param("project_id")]
const TABLE_IN_PROJECT = [/* @__PURE__ */ param("project_id"), /* @__PURE__ */ param("table_id")]

function tables(): object {
	return {
		get: {
			operationId: "table.list",
			parameters: PROJECT,
			responses: listed("tables", TABLE),
			...entity("list", "table"),
		},
		post: {
			operationId: "table.create",
			parameters: PROJECT,
			requestBody: {
				...json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
				required: true,
			},
			responses: { "201": { ...json(TABLE), description: "created" } },
			...entity("create", "table"),
		},
	}
}

/** The extract: one write that creates a table and appends at least one row to it, then waits for the rows. */
function extract(): object {
	return {
		post: {
			operationId: "extract.once",
			parameters: PROJECT,
			responses: { "200": { ...json(TABLE), description: "ok" } },
			"x-effects": [
				{ entity: "table", op: "create" },
				{ entity: "row", min: 1, op: "append" },
			],
			...entity("action", "table"),
			"x-wait": { operationId: "row.list", pollIntervalMs: 40, timeoutMs: 800, until: "$.rows.0" },
		},
	}
}

export function extractSpec(): OpenApiDocument {
	return {
		info: { title: "extract-effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": tables(),
			"/v1/projects/{project_id}/tables/{table_id}": {
				get: {
					operationId: "table.read",
					parameters: TABLE_IN_PROJECT,
					responses: { "200": { ...json(TABLE), description: "ok" } },
					...entity("read", "table"),
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}/rows": {
				get: {
					operationId: "row.list",
					parameters: TABLE_IN_PROJECT,
					responses: listed("rows", ROW),
					...entity("list", "row"),
				},
			},
			"/v1/projects/{project_id}/extract": extract(),
		},
	} as OpenApiDocument
}
