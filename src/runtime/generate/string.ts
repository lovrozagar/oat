/** A string value within the schema's length, format and pattern. */

import { codePointCount, sliceCodePoints } from "../payloads.ts"
import { formatted } from "./format.ts"
import { matches, matching } from "./pattern.ts"
import { text } from "./text.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { At } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

function padFormatted(format: string, value: string, min: number): string {
	const short = min - codePointCount(value)
	if (short <= 0) return value
	if (format === "email" || format === "idn-email") return value.replace("@", `${"x".repeat(short)}@`)
	if (format.startsWith("uri") || format.startsWith("iri") || format === "url") return `${value}${"x".repeat(short)}`
	if (format === "hostname" || format === "idn-hostname") return `${"x".repeat(Math.min(short, 60))}${value}`
	return value
}

interface Bounds {
	min: number
	max: number
	pattern: string | undefined
}

/* A short address or URL can be lengthened without leaving its format; a date cannot. */
function inFormat(format: string, bounds: Bounds, at: At): string | undefined {
	const unpadded = formatted(format, at.ctx, at.distinct)
	if (unpadded === undefined) return undefined
	const { min, max, pattern } = bounds
	const known = padFormatted(format, unpadded, min)
	if (codePointCount(known) > max || codePointCount(known) < min) {
		throw new Unconstructible(`a ${format} cannot fit length ${min}–${max}`, at.pointer)
	}
	if (pattern !== undefined && !matches(pattern, known)) {
		throw new Unconstructible(`a ${format} cannot match pattern ${pattern}`, at.pointer)
	}
	return known
}

/** The variant's text, cut to `max` or padded to `min`. */
function plain(min: number, max: number, at: At): string {
	const { ctx, distinct } = at
	let value = ctx.variant === "boundary" ? "B".repeat(Math.max(1, Math.min(max, 512))) : text(ctx, distinct)
	if (codePointCount(value) > max) {
		/* Keep the distinguishing tail when shortening: the index and nonce are what make it unique. */
		const tail = distinct && ctx.nonce !== undefined ? ` ${ctx.nonce}` : ` ${ctx.index}`
		value =
			codePointCount(tail) < max
				? sliceCodePoints(value, max - codePointCount(tail)) + tail
				: sliceCodePoints(value, max)
	}
	if (codePointCount(value) < min) value = value + "x".repeat(min - codePointCount(value))
	return value
}

export function stringFor(schema: JsonSchema, at: At): string {
	const min = typeof schema.minLength === "number" ? schema.minLength : 0
	const max = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY
	if (min > max) throw new Unconstructible(`minLength ${min} exceeds maxLength ${max}`, at.pointer)
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : undefined
	const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined

	const known = format === undefined ? undefined : inFormat(format, { max, min, pattern }, at)
	if (known !== undefined) return known
	if (pattern !== undefined) {
		const candidate = matching(pattern, { max, min }, at)
		if (candidate === undefined) throw new Unconstructible(`no string found for pattern ${pattern}`, at.pointer)
		return candidate
	}
	return plain(min, max, at)
}
