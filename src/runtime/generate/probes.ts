/** Values a write probe sends: another valid value, or one just outside what the schema allows. */

import { isObject } from "./algebra.ts"
import { generate } from "./generate.ts"
import type { GenerateOptions, Generated } from "./types.ts"

/** A valid value that differs from `other` — the value a write probe changes a field to. */
export function distinctValue(schema: unknown, other: unknown, options: GenerateOptions = {}): Generated {
	const base = options.index ?? 0
	for (let index = base + 1; index < base + 12; index++) {
		const result = generate(schema, { ...options, index })
		if (!result.ok) return result
		if (JSON.stringify(result.value) !== JSON.stringify(other)) return result
	}
	return { ok: false, pointer: "/", reason: "the schema admits no value different from the current one" }
}

/** A value of the right type outside the declared enum, or why there is none. */
export function outsideEnum(schema: unknown): Generated {
	if (!isObject(schema) || !Array.isArray(schema.enum)) return { ok: false, pointer: "/", reason: "no enum declared" }
	const values = schema.enum
	if (values.every((value) => typeof value === "number")) {
		return { ok: true, value: Math.max(...(values as number[])) + 1 }
	}
	let candidate = "oat-not-in-enum"
	while (values.includes(candidate)) candidate = `${candidate}-x`
	return { ok: true, value: candidate }
}

/** A string one character longer than `maxLength` allows, or why there is none. */
export function overMaxLength(schema: unknown): Generated {
	if (!isObject(schema) || typeof schema.maxLength !== "number") {
		return { ok: false, pointer: "/", reason: "no maxLength declared" }
	}
	return { ok: true, value: "x".repeat(schema.maxLength + 1) }
}
