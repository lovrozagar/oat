/** A number or integer within the schema's bounds and step. */

import { nonceNumber } from "./nonce.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { At } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

interface Bounds {
	integer: boolean
	/** `multipleOf`, or 1 for an integer, or 0 for no step. */
	step: number
	lo: number
	hi: number
	exclusiveLo: number | undefined
	exclusiveHi: number | undefined
}

function boundsOf(schema: JsonSchema, integer: boolean): Bounds {
	const step = typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : integer ? 1 : 0
	const exclusiveLo = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined
	const exclusiveHi = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined
	const lo = Math.max(
		typeof schema.minimum === "number" ? schema.minimum : Number.NEGATIVE_INFINITY,
		exclusiveLo ?? Number.NEGATIVE_INFINITY,
	)
	const hi = Math.min(
		typeof schema.maximum === "number" ? schema.maximum : Number.POSITIVE_INFINITY,
		exclusiveHi ?? Number.POSITIVE_INFINITY,
	)
	return { exclusiveHi, exclusiveLo, hi, integer, lo, step }
}

function admits(b: Bounds, value: number): boolean {
	return (
		value >= b.lo &&
		value <= b.hi &&
		(b.exclusiveLo === undefined || value > b.exclusiveLo) &&
		(b.exclusiveHi === undefined || value < b.exclusiveHi) &&
		(!b.integer || Number.isInteger(value)) &&
		(b.step === 0 || Math.abs(value / b.step - Math.round(value / b.step)) < 1e-9)
	)
}

function snap(step: number, value: number, direction: "up" | "down"): number {
	if (step === 0) return value
	const units = direction === "up" ? Math.ceil(value / step - 1e-9) : Math.floor(value / step + 1e-9)
	return Number((units * step).toFixed(10))
}

/* A ladder whose lexical order differs from its numeric order (1, 10, 100, 2, 20, 5, 50 as
 * text), so a backend comparing numbers as strings is visibly wrong. */
const LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 100]

function preferredOf(b: Bounds, at: At): number {
	const { ctx, distinct } = at
	const rung = LADDER[ctx.index % LADDER.length] ?? 1
	const origin = Number.isFinite(b.lo) ? b.lo : 0
	const fraction = b.integer ? 0 : Math.round(ctx.rand() * 9) / 10
	const offset = distinct && ctx.nonce !== undefined ? nonceNumber(ctx.nonce) % 997 : 0
	if (ctx.variant === "boundary" && Number.isFinite(b.hi)) return b.hi
	if (ctx.variant === "boundary" && Number.isFinite(b.lo)) return b.lo
	return origin + rung + fraction + offset * Math.max(b.step, 1)
}

export function numberFor(schema: JsonSchema, at: At, integer: boolean): number {
	const b = boundsOf(schema, integer)
	const preferred = preferredOf(b, at)
	const { lo, hi, step } = b
	const clamped = Math.min(Math.max(preferred, lo), hi)
	const base = Number.isFinite(lo) ? lo : 0
	const candidates = [
		snap(step, clamped, "up"),
		snap(step, clamped, "down"),
		snap(step, lo, "up"),
		snap(step, hi, "down"),
		snap(step, base + (Number.isFinite(hi) ? (hi - base) / 2 : 1), "up"),
	]
	/* An integer always has a step (1 at least), so only a number is nudged by a half. */
	const nudge = step || 0.5
	for (const candidate of candidates) {
		if (Number.isFinite(candidate) && admits(b, candidate)) return candidate
		if (Number.isFinite(candidate) && admits(b, candidate + nudge)) return candidate + nudge
	}
	throw new Unconstructible(`no ${integer ? "integer" : "number"} satisfies the bounds`, at.pointer)
}
