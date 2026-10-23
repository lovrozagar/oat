import { isObject } from "./algebra.ts"
import { text } from "./text.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { At, Walk } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

export function objectFor(schema: JsonSchema, at: At, walk: Walk): Record<string, unknown> {
	const { ctx, pointer } = at
	const properties = isObject(schema.properties) ? schema.properties : {}
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
	const out: Record<string, unknown> = {}
	for (const [name, sub] of Object.entries(properties)) {
		if (!required.has(name) && ctx.optional === "none") continue
		const child = `${pointer}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`
		const distinct = pointer === "" && ctx.distinct.has(name)
		try {
			out[name] = walk(sub, { ctx, distinct, pointer: child })
		} catch (error) {
			/* An optional property that cannot be made is left out; a required one cannot be. */
			if (!(error instanceof Unconstructible) || required.has(name)) throw error
		}
	}
	for (const name of required) {
		if (Object.hasOwn(out, name)) continue
		/* Required but undescribed: any value satisfies the schema. */
		out[name] = text(ctx, false)
	}
	return out
}
