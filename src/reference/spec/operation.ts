/** Pieces every operation is assembled from: its success status, its responses, its tag and identity. */

import type { Dialect } from "../dialect/types.ts"
import type { EntityDef } from "../model/types.ts"
import type { Json, SpecContext } from "./types.ts"
import type { JsonSchema } from "../../spec/types.ts"

/** A success status as the document spells it — exactly, or as the `2XX` range. */
export function ok(ctx: SpecContext, status: number): string {
	return ctx.shape.rangeStatuses === true ? "2XX" : String(status)
}

export function jsonResponse(description: string, schema: JsonSchema, headers?: Json): Json {
	const response: Json = { content: { "application/json": { schema } }, description }
	if (headers !== undefined) response["headers"] = headers
	return response
}

/** RFC 8288 pagination links, declared only by dialects that actually publish them. */
export function listResponseHeaders(dialect: Dialect): Json | undefined {
	if (dialect.envelope !== null) return undefined
	return {
		Link: {
			description: 'Pagination links; rel="next" is present while further pages remain',
			schema: { type: "string" },
		},
	}
}

/** The identity the document declares: under `tableKey`, a table is known by its slug. */
export function declaredIdentity(ctx: SpecContext, entity: EntityDef): string {
	return ctx.shape.tableKey === "slug" && entity.name === "table" ? "slug" : entity.identity
}

/** The tag an entity's own operations are grouped under: its name, capitalized. */
export function entityTag(entity: EntityDef): string {
	return entity.name[0]?.toUpperCase() + entity.name.slice(1)
}
