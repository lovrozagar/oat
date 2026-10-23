import type { JsonSchema } from "../../spec/types.ts"
import type { At, Walk } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

function itemBounds(schema: JsonSchema, pointer: string): { min: number; max: number } {
	const min = typeof schema.minItems === "number" ? schema.minItems : 0
	const max = typeof schema.maxItems === "number" ? schema.maxItems : Number.POSITIVE_INFINITY
	if (min > max) throw new Unconstructible(`minItems ${min} exceeds maxItems ${max}`, pointer)
	return { max, min }
}

export function arrayFor(schema: JsonSchema, at: At, walk: Walk): unknown[] {
	const { ctx, pointer } = at
	const { min, max } = itemBounds(schema, pointer)
	const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : []
	const out: unknown[] = prefix.map((item, position) =>
		walk(item, { ctx: { ...ctx, index: ctx.index + position }, distinct: false, pointer: `${pointer}/${position}` }),
	)
	/* One element where the schema allows it: an empty array fails `minItems` on exactly the
	 * collections most worth testing, and one element is what a cohort needs to filter on. */
	const want = Math.min(Math.max(min, prefix.length, 1), max)
	const items = schema.items
	if (items === false || out.length >= want) return out
	const seen = new Set(out.map((value) => JSON.stringify(value)))
	for (let attempt = 0; out.length < want && attempt < want + 8; attempt++) {
		let value: unknown
		try {
			value = walk(items ?? true, {
				ctx: { ...ctx, index: ctx.index + attempt },
				distinct: false,
				pointer: `${pointer}/${out.length}`,
			})
		} catch (error) {
			if (error instanceof Unconstructible && out.length >= min) break
			throw error
		}
		const key = JSON.stringify(value)
		if (schema.uniqueItems === true && seen.has(key)) continue
		seen.add(key)
		out.push(value)
	}
	if (out.length < min) throw new Unconstructible(`cannot make ${min} distinct items`, pointer)
	return out
}
