/** The keywords that pick among schemas: a `$ref` into the document's defs, a union, an enum. */

import { DEFS_ID } from "../../spec/load/defs.ts"
import { isObject, merge } from "./algebra.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { At, Context, Walk } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

/** How many times one recursive schema may nest inside itself before generation stops descending. */
const RECURSION_BOUND = 2

/** The value `schema.$ref` names, with the schema's sibling keywords applied. */
export function viaRef(schema: JsonSchema, at: At, walk: Walk): unknown {
	const { ctx, pointer } = at
	const ref = schema.$ref as string
	const name = ref.startsWith(`${DEFS_ID}#/$defs/`) ? ref.slice(`${DEFS_ID}#/$defs/`.length) : undefined
	const target = name === undefined ? undefined : ctx.defs[name]
	if (name === undefined || target === undefined) {
		throw new Unconstructible(`cannot follow ${ref}`, pointer)
	}
	if (ctx.refs.filter((seen) => seen === name).length >= RECURSION_BOUND) {
		throw new Unconstructible(`recursion through ${name} is bounded at depth ${RECURSION_BOUND}`, pointer)
	}
	const { $ref: _ref, ...siblings } = schema
	const inner = { ...ctx, refs: [...ctx.refs, name] }
	return walk(Object.keys(siblings).length === 0 ? target : merge(target, siblings), { ...at, ctx: inner })
}

const isNull = (branch: unknown): boolean => isObject(branch) && branch.type === "null"

/**
 * A union keeps its base: `{properties: {kind}, oneOf: [...]}` needs `kind` whichever branch. The
 * index picks the branch to start from, as it picks an enum value, so a cohort makes every branch.
 */
export function unionOf(schema: JsonSchema, at: At, walk: Walk): unknown {
	const union = (schema.oneOf ?? schema.anyOf) as unknown[]
	const { oneOf: _o, anyOf: _a, ...base } = schema
	if (at.ctx.variant === "null-heavy" && union.some(isNull)) return null
	const options = union.filter((candidate) => !isNull(candidate))
	/* With no options the start is NaN, and `slice` reads NaN as 0. */
	const start = at.ctx.index % options.length
	const failures: string[] = []
	for (const branch of [...options.slice(start), ...options.slice(0, start)]) {
		const candidate = isObject(branch) ? merge(base, branch) : branch
		try {
			return walk(candidate, at)
		} catch (error) {
			if (!(error instanceof Unconstructible)) throw error
			failures.push(error.reason)
		}
	}
	if (union.some(isNull)) return null
	throw new Unconstructible(`no branch of the union can be generated: ${failures.join("; ")}`, at.pointer)
}

export function enumOf(values: unknown[], ctx: Context, pointer: string): unknown {
	const options = values.filter((item) => item !== null)
	if (ctx.variant === "null-heavy" && values.includes(null)) return null
	if (options.length === 0) {
		if (values.includes(null)) return null
		throw new Unconstructible("the enum is empty", pointer)
	}
	return options[ctx.index % options.length]
}
