/** Strings for a documented `pattern`: a bounded search over likely candidates. */

import { codePointCount } from "../payloads.ts"
import { expand } from "./expand.ts"
import { uuidFrom } from "./format.ts"
import { slug } from "./text.ts"
import type { At } from "./types.ts"

export function matches(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern, "u").test(value)
	} catch {
		return false
	}
}

/** A bounded search for a string the documented pattern accepts. */
export function matching(pattern: string, length: { min: number; max: number }, at: At): string | undefined {
	const { ctx, distinct } = at
	const { min, max } = length
	const suffix = distinct && ctx.nonce !== undefined ? ctx.nonce : String(ctx.index)
	const fromPattern = expand(pattern, ctx.index)
	const candidates = [
		fromPattern === undefined ? undefined : `${fromPattern}${suffix}`,
		fromPattern,
		`oat${suffix}`,
		`a${suffix}`,
		suffix,
		`oat-${suffix}`,
		`oat_${suffix}`,
		`OAT${suffix}`,
		"a",
		"abc",
		`oat-${slug(ctx.variant)}-${suffix}@example.test`,
		`https://example.test/${suffix}`,
		uuidFrom(`${ctx.variant}:${suffix}`),
	]
	for (const candidate of candidates) {
		if (candidate === undefined) continue
		for (const sized of [candidate, candidate.slice(0, max), candidate.padEnd(min, candidate.at(-1) ?? "a")]) {
			const n = codePointCount(sized)
			if (n >= min && n <= max && matches(pattern, sized)) return sized
		}
	}
	return undefined
}
