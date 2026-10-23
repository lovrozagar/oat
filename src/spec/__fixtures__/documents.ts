import type { JsonSchema, OpenApiDocument, ParameterObject } from "../types.ts"

/* Small builders for the documents the spec modules' tests read. */

export const member = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id"],
	type: "object",
}

export const list = (items: unknown): Record<string, unknown> => ({ items, type: "array" })

export const ok = (schema: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	"200": { content: { "application/json": { schema } }, description: "ok", ...extra },
})

export const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}): OpenApiDocument =>
	({ info: { title: "t", version: "1" }, openapi: "3.1.0", paths, ...extra }) as OpenApiDocument

export const query = (
	name: string,
	schema: JsonSchema = { type: "string" },
	extra: Record<string, unknown> = {},
): ParameterObject => ({ in: "query", name, schema, ...extra })

/** A collection under `/v1/<parent>/{<param>}/members`, with its create and item read. */
export const members = (parent: string, param: string): Record<string, unknown> => ({
	[`/v1/${parent}/{${param}}/members`]: {
		get: { operationId: `${parent}.members.list`, responses: ok(list(member)) },
		post: { operationId: `${parent}.members.create`, responses: ok(member) },
	},
	[`/v1/${parent}/{${param}}/members/{member_id}`]: {
		get: { operationId: `${parent}.members.get`, responses: ok(member) },
	},
})
