/** Values a probe sends where a record would be named or filtered on, chosen to name nothing. */

import { isObject, typesOf } from "./algebra.ts"
import { uuidFrom } from "./format.ts"
import { generate } from "./generate.ts"
import { nonceNumber } from "./nonce.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { Generated } from "./types.ts"

function tokenFits(token: string, schema: JsonSchema): boolean {
	if (typeof schema.minLength === "number" && token.length < schema.minLength) return false
	if (typeof schema.maxLength === "number" && token.length > schema.maxLength) return false
	if (typeof schema.pattern !== "string") return true
	try {
		return new RegExp(schema.pattern, "u").test(token)
	} catch {
		return false
	}
}

/**
 * An identifier that is well-formed for `schema` and names nothing: a UUID where the API takes
 * UUIDs, an integer where it takes integers. Comparing a malformed probe against a real one
 * compares a 400 with a 404 and reads the difference as a leak.
 */
export function absentIdentifier(schema: unknown, nonce: string): Generated {
	const s = isObject(schema) ? schema : {}
	const types = typesOf(s)
	if (types.includes("integer") || types.includes("number")) {
		const hi = typeof s.maximum === "number" ? s.maximum : 2_147_483_647
		const value = Math.max(typeof s.minimum === "number" ? s.minimum : 1, hi - (nonceNumber(nonce) % 1000))
		return { ok: true, value: Number.isInteger(value) ? value : Math.floor(value) }
	}
	const format = typeof s.format === "string" ? s.format : undefined
	if (format === "uuid") return { ok: true, value: uuidFrom(`absent:${nonce}`) }
	/* A string identity with a format of its own (an email, a date) is made in that format. */
	if (format !== undefined) return generate({ ...s, format }, { distinct: new Set(), index: 9001, nonce })
	/* Otherwise one token, plainly oat's: a value made to look like data (`Quarterly Report 9001`)
	 * is no identifier anyone issues. A schema the token cannot meet leaves the probe without one. */
	if (Array.isArray(s.enum))
		return { ok: false, pointer: "/", reason: "an enumerated identity names only records that may exist" }
	const token = `oat-absent-${nonceNumber(nonce).toString(36)}`
	return tokenFits(token, s)
		? { ok: true, value: token }
		: { ok: false, pointer: "/", reason: "no single token meets the identity's pattern or length" }
}

/**
 * A value of the field's own type that no record is likely to hold — the probe for "is this
 * declared filter accepted at all". A string where the field is a string, a number where it is one.
 */
export function filterSentinel(schema: unknown, nonce: string): Generated {
	const s = isObject(schema) ? schema : {}
	if (Array.isArray(s.enum) && s.enum.length > 0) return { ok: true, value: s.enum.at(-1) }
	const types = typesOf(s)
	if (types.includes("boolean")) return { ok: true, value: true }
	if (types.includes("integer") || types.includes("number")) return absentIdentifier(s, nonce)
	const wrapped = generate(
		{ properties: { value: s }, required: ["value"], type: "object" },
		{ distinct: new Set(["value"]), index: 4242, nonce, variant: "lexical-last" },
	)
	return wrapped.ok ? { ok: true, value: (wrapped.value as Record<string, unknown>).value } : wrapped
}
