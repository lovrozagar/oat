import { buildModel } from "../../../spec/graph/build.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"

/*
 * Small documents for parent-id binding: projects own tables, tables own rows, and an extract
 * action creates a table and appends rows to it.
 */

const pathParam = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const table = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const entity = (action: string, name: string) => ({ "x-entity": { action, identity: "id", name } })

/** Projects → tables → rows, with a table's full CRUD and an extract that creates both. */
export function tablesModel(): SpecModel {
	const item = [pathParam("project_id"), pathParam("table_id")]
	return buildModel({
		info: { title: "effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": {
				get: {
					operationId: "table.list",
					parameters: [pathParam("project_id")],
					responses: {
						"200": { description: "ok", ...json({ properties: { tables: { items: table, type: "array" } } }) },
					},
					...entity("list", "table"),
				},
				post: {
					operationId: "table.create",
					parameters: [pathParam("project_id")],
					requestBody: { required: true, ...json({ properties: { name: { type: "string" } }, type: "object" }) },
					responses: { "201": { description: "created", ...json(table) } },
					...entity("create", "table"),
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}": {
				delete: {
					operationId: "table.delete",
					parameters: item,
					responses: { "204": { description: "gone" } },
					...entity("delete", "table"),
				},
				get: {
					operationId: "table.read",
					parameters: item,
					responses: { "200": { description: "ok", ...json(table) } },
					...entity("read", "table"),
				},
				patch: {
					operationId: "table.update",
					parameters: item,
					responses: { "200": { description: "ok", ...json(table) } },
					...entity("update", "table"),
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}/rows": {
				get: {
					operationId: "row.list",
					parameters: item,
					responses: { "200": { description: "ok" } },
					...entity("list", "row"),
				},
			},
		},
	} as unknown as OpenApiDocument)
}

/** One entity `name` with a list, and an item route `/{param}` for each action in `actions`. */
export function itemModel(
	name: string,
	param: string,
	actions: ReadonlyArray<"read" | "update" | "delete">,
): SpecModel {
	const methods = { delete: "delete", read: "get", update: "patch" } as const
	const route: Record<string, unknown> = {}
	for (const action of actions) {
		route[methods[action]] = {
			operationId: `${name}.${action}`,
			parameters: [pathParam(param)],
			responses: { "200": { description: "ok" } },
			...entity(action, name),
		}
	}
	return buildModel({
		info: { title: name, version: "1" },
		openapi: "3.1.0",
		paths: {
			[`/v1/${name}s`]: {
				get: { operationId: `${name}.list`, responses: { "200": { description: "ok" } }, ...entity("list", name) },
				post: { operationId: `${name}.create`, responses: { "201": { description: "ok" } }, ...entity("create", name) },
			},
			...(actions.length === 0 ? {} : { [`/v1/${name}s/{${param}}`]: route }),
		},
	} as unknown as OpenApiDocument)
}
