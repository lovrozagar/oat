/**
 * Schema-driven fixture generation: the discriminating cohort.
 *
 * Valid-random data cannot test a query engine: `ilike` needs a substring, `order` needs a total
 * order, escaping needs metacharacters. oat seeds a *cohort* — one record per variant, each shaped
 * so some query assertion has signal — and derives everything from a seed so a failing run is
 * exactly reproducible.
 *
 * The values themselves come from `generate.ts`, the one place oat invents data, from the request
 * schema as `spec/schema.ts` normalizes it. Every body is checked against that schema before it
 * leaves; one that cannot be made valid is a gap naming the operation and the field, never a
 * request the document forbids.
 */

import { normalizeSchema } from "../spec/schema.ts"
import { type Variant, generate, isVacuous } from "./generate.ts"
import { instanceErrors } from "./validate.ts"

export type { Variant } from "./generate.ts"
export { isVacuous } from "./generate.ts"

export const COHORT: readonly Variant[] = [
	"baseline",
	"lexical-first",
	"lexical-last",
	"null-heavy",
	"unicode",
	"metacharacter",
	"boundary",
]

/** Deterministic PRNG — same seed, same cohort, every run. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Schema = Record<string, unknown>

export interface CohortMember {
	variant: Variant
	body: Record<string, unknown>
}

/**
 * Thrown when no valid body can be built for an operation. The pointer names the field; the
 * reason says why — and the fix is `hooks.resolveInput`, which can supply what the schema cannot.
 */
export class FixtureOverflow extends Error {
	constructor(
		readonly operationId: string,
		readonly pointer: string,
		readonly reason?: string,
	) {
		super(
			reason === undefined
				? `fixture generation overflow on ${operationId} (${pointer})`
				: `cannot generate a valid body for ${operationId} at ${pointer}: ${reason} — supply one with hooks.resolveInput`,
		)
		this.name = "FixtureOverflow"
	}
}

export function overflowFrom(error: unknown, operationId: string, pointer = "/"): FixtureOverflow {
	if (error instanceof FixtureOverflow) {
		return new FixtureOverflow(operationId, error.pointer === "/" ? pointer : error.pointer, error.reason)
	}
	return new FixtureOverflow(operationId, pointer)
}

export function isOverflowError(error: unknown): boolean {
	if (error instanceof FixtureOverflow) return true
	return error instanceof RangeError
}

export interface CohortOptions {
	/** Recursive schemas the document refers to as `oat-defs#/$defs/<name>`. */
	defs?: Record<string, Schema>
	/** Per-run token for values that must not collide with an earlier run's. */
	nonce?: string
	/** Top-level fields whose values must be distinct across runs too — the x-unique columns. */
	distinct?: ReadonlySet<string>
}

function requestSchema(schema: Schema | boolean): Schema | boolean {
	return typeof schema === "object" && schema !== null ? normalizeSchema(schema, { direction: "request" }) : schema
}

/** One body per variant, each valid for the schema — or a `FixtureOverflow` naming what is not. */
export function buildCohort(
	bodySchema: Schema | boolean,
	seed: number,
	variants: readonly Variant[] = COHORT,
	operationId = "unknown",
	options: CohortOptions = {},
): CohortMember[] {
	const schema = requestSchema(bodySchema)
	return variants.map((variant, index) => {
		const result = generate(schema, {
			...(options.defs === undefined ? {} : { defs: options.defs }),
			...(options.distinct === undefined ? {} : { distinct: options.distinct }),
			...(options.nonce === undefined ? {} : { nonce: options.nonce }),
			index,
			rand: mulberry32(seed + index * 7919),
			variant,
		})
		if (!result.ok) throw new FixtureOverflow(operationId, result.pointer, result.reason)
		const body = isObject(result.value) ? result.value : {}
		/* The self-check: a body oat invented must satisfy the document before it is sent. */
		if (typeof schema === "object" && !isVacuous(schema)) {
			const errors = instanceErrors(schema, body, options.defs)
			if (errors.length > 0) throw new FixtureOverflow(operationId, "/", errors.slice(0, 3).join("; "))
		}
		return { body, variant }
	})
}

/**
 * One body, with the required fields that could not be made rather than an exception — for
 * callers that report each gap themselves. Optional fields that cannot be made are left out.
 */
export function generateBody(
	bodySchema: Schema | boolean,
	variant: Variant,
	rand: () => number,
	index: number,
	operationId = "unknown",
): { body: Record<string, unknown>; missingRequired: string[] } {
	void operationId
	const schema = requestSchema(bodySchema)
	const result = generate(schema, { index, rand, variant })
	if (result.ok) return { body: isObject(result.value) ? result.value : {}, missingRequired: [] }
	/* Without the failing field, the rest may still be made: drop it from `required` and retry. */
	const field = result.pointer.split("/")[1]
	if (field !== undefined && field !== "" && typeof schema === "object") {
		const required = Array.isArray(schema.required) ? schema.required.filter((name) => name !== field) : []
		const properties = { ...(schema.properties as Schema) }
		delete properties[field]
		const rest = generateBody({ ...schema, properties, required }, variant, rand, index, operationId)
		return { body: rest.body, missingRequired: [result.pointer, ...rest.missingRequired] }
	}
	return { body: {}, missingRequired: [result.pointer] }
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Makes unique-set tuples differ across cohort members, by drawing new values from each
 * column's schema. When the document cannot express two distinct values — a two-value enum and
 * seven members — the extra members are dropped and the caller records a gap.
 */
export function ensureDistinctUniqueValues(
	members: CohortMember[],
	sets: string[][],
	schema: Schema | boolean,
	options: CohortOptions = {},
): { members: CohortMember[]; gap: string | null } {
	if (sets.length === 0 || members.length <= 1) return { gap: null, members }
	const normalized = requestSchema(schema)
	const properties = typeof normalized === "object" && isObject(normalized.properties) ? normalized.properties : {}
	const kept: CohortMember[] = []
	for (const member of members) {
		const body = { ...member.body }
		let ok = true
		for (const set of sets) {
			for (let attempt = 0; kept.some((prior) => sameUniqueTuple(prior.body, body, set)) && attempt < 16; attempt++) {
				const col = set.find((name) => Object.hasOwn(body, name) && isObject(properties[name]))
				if (col === undefined) break
				const redrawn = generate(
					{ properties: { [col]: properties[col] }, required: [col], type: "object" },
					{
						...(options.defs === undefined ? {} : { defs: options.defs }),
						distinct: new Set([col]),
						index: kept.length * 17 + attempt + 1,
						nonce: `${options.nonce ?? ""}${attempt}`,
					},
				)
				if (!redrawn.ok) break
				body[col] = (redrawn.value as Record<string, unknown>)[col]
			}
			if (kept.some((prior) => sameUniqueTuple(prior.body, body, set))) ok = false
			if (!ok) break
		}
		if (ok) kept.push({ body, variant: member.variant })
	}
	if (kept.length === members.length) return { gap: null, members: kept }
	if (kept.length === 0) return { gap: uniqueDistinctGap(sets), members: members.slice(0, 1) }
	return { gap: uniqueDistinctGap(sets), members: kept }
}

function uniqueDistinctGap(sets: string[][]): string {
	const shown = sets.map((set) => `[${set.join(", ")}]`).join("; ")
	return `x-unique cannot express distinct values for ${shown} within the schema; extra variants skipped`
}

function sameUniqueTuple(a: Record<string, unknown>, b: Record<string, unknown>, set: string[]): boolean {
	const cols = set.filter((col) => Object.hasOwn(a, col) || Object.hasOwn(b, col))
	if (cols.length === 0) return false
	return cols.every((col) => JSON.stringify(a[col]) === JSON.stringify(b[col]))
}
