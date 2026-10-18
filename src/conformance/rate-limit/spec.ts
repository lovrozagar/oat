/** The two documents the rate-limit suite serves: untagged things, and tables behind a plan limit. */

import type { OpenApiDocument } from "../../spec/types.ts"

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const json = (schema: object) => ({ content: { "application/json": { schema } } })

const PAGE = {
	"200": {
		.../* @__PURE__ */ json({
			properties: { items: { items: ITEM, type: "array" } },
			required: ["items"],
			type: "object",
		}),
		description: "ok",
	},
}
const NAME_BODY = {
	.../* @__PURE__ */ json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
	required: true,
}
const CREATED = { "201": { .../* @__PURE__ */ json(ITEM), description: "created" } }
const READ = { "200": { .../* @__PURE__ */ json(ITEM), description: "ok" } }
const GONE = { "204": { description: "gone" } }

const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

interface Operation {
	parameters: string[]
	requestBody?: object
	responses: object
}

function operation(entity: string, action: string, { parameters, requestBody, responses }: Operation): object {
	return {
		operationId: `${entity}.${action}`,
		...(parameters.length === 0 ? {} : { parameters: parameters.map(param) }),
		...(requestBody === undefined ? {} : { requestBody }),
		responses,
		"x-entity": { action, identity: "id", name: entity },
	}
}

/** An entity's collection (list, create) and item (delete, read), under their path parameters. */
interface Resource {
	collection: string[]
	item: string[]
	created: object
}

function resource(entity: string, { collection, item, created }: Resource): [object, object] {
	return [
		{
			get: operation(entity, "list", { parameters: collection, responses: PAGE }),
			post: operation(entity, "create", { parameters: collection, requestBody: NAME_BODY, responses: created }),
		},
		{
			delete: operation(entity, "delete", { parameters: item, responses: GONE }),
			get: operation(entity, "read", { parameters: item, responses: READ }),
		},
	]
}

function document(title: string, paths: Record<string, object>): OpenApiDocument {
	return { info: { title, version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument
}

/** Things with no `x-rate-limit` tag: a 429 can only be met reactively. */
export function thingSpec(): OpenApiDocument {
	const [things, thing] = resource("thing", { collection: [], created: CREATED, item: [] })
	return document("untagged-429", { "/v1/things": things, "/v1/things/{id}": thing })
}

/** Tables whose create is plan-limited (a documented 402), and the rows inside them. */
export function planLimitSpec(): OpenApiDocument {
	const [tables, table] = resource("table", {
		collection: [],
		created: { ...CREATED, "402": { description: "payment_required" } },
		item: ["table_id"],
	})
	const [rows, row] = resource("row", { collection: ["table_id"], created: CREATED, item: ["table_id", "row_id"] })
	return document("plan-limit", {
		"/v1/tables": tables,
		"/v1/tables/{table_id}": table,
		"/v1/tables/{table_id}/rows": rows,
		"/v1/tables/{table_id}/rows/{row_id}": row,
	})
}
