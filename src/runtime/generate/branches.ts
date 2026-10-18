/** The keywords that pick among schemas: a `$ref` into the document's defs, a union, an enum. */

import { DEFS_ID } from "../../spec/load/defs.ts"
import { isObject, merge } from "./algebra.ts"
import type { At, Context, Schema, Walk } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

/** How many times one recursive schema may nest inside itself before generation stops descending. */
const RECURSION_BOUND = 2

export function viaRef(schema: Schema, ref: string, at: At, walk: Walk): unknown {
	const { ctx, pointer } = at
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
	return walk(Object.keys(siblings).length === 0 ? target : merge(target, siblings), inner, pointer, at.distinct)
}

const isNull = (branch: unknown): boolean => isObject(branch) && branch.type === "null"

/* A union keeps its base: `{properties: {kind}, oneOf: [...]}` needs `kind` whichever branch. */
export function unionOf(schema: Schema, union: unknown[], at: At, walk: Walk): unknown {
	const { oneOf: _o, anyOf: _a, ...base } = schema
	if (at.ctx.variant === "null-heavy" && union.some(isNull)) return null
	const failures: string[] = []
	for (const branch of union.filter((candidate) => !isNull(candidate))) {
		const candidate = isObject(branch) ? merge(base, branch) : branch
		try {
			return walk(candidate, at.ctx, at.pointer, at.distinct)
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
