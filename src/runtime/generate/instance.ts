/** The walk: one value for a schema, descending through its keywords. */

import { isObject, isVacuous, mergeAll, typesOf } from "./algebra.ts"
import { arrayFor } from "./array.ts"
import { enumOf, unionOf, viaRef } from "./branches.ts"
import { numberFor } from "./number.ts"
import { objectFor } from "./object.ts"
import { stringFor } from "./string.ts"
import { text } from "./text.ts"
import type { At, Context, Schema } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

const MAX_DEPTH = 12

/** A value of the schema's first non-null type. */
function typed(schema: Schema, at: At): unknown {
	const { ctx, pointer } = at
	const types = typesOf(schema)
	if (ctx.variant === "null-heavy" && types.includes("null")) return null
	const type = types.find((item) => item !== "null")
	if (type === undefined) return null

	const next = { ...ctx, depth: ctx.depth + 1 }
	switch (type) {
		case "string":
			return stringFor(schema, at)
		case "integer":
		case "number":
			return numberFor(schema, at, type === "integer")
		case "boolean":
			return ctx.index % 2 === 0
		case "array":
			return arrayFor(schema, next, pointer, instance)
		case "object":
			return objectFor(schema, next, pointer, instance)
		default:
			throw new Unconstructible(`unknown type "${type}"`, pointer)
	}
}

export function instance(raw: unknown, ctx: Context, pointer: string, distinct: boolean): unknown {
	if (ctx.depth > MAX_DEPTH) throw new Unconstructible("the schema nests too deeply to generate", pointer)
	if (raw === false) throw new Unconstructible("the schema admits no value (false)", pointer)
	if (raw === true || isVacuous(raw)) return text(ctx, distinct)
	if (!isObject(raw)) throw new Unconstructible("the schema is not an object", pointer)
	const at: At = { ctx, distinct, pointer }
	if (typeof raw.$ref === "string") return viaRef(raw, raw.$ref, at, instance)

	const schema = raw.allOf === undefined ? raw : mergeAll(raw, raw.allOf, pointer)
	if ("const" in schema) return schema.const

	const union = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined
	if (Array.isArray(union) && union.length > 0) return unionOf(schema, union, at, instance)
	if (Array.isArray(schema.enum)) return enumOf(schema.enum, ctx, pointer)
	return typed(schema, at)
}
