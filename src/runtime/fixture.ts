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
import { type Variant } from "./generate/types.ts"
import { generate } from "./generate/generate.ts"
import { isVacuous } from "./generate/algebra.ts"
import { instanceErrors } from "./validate.ts"
import { messageOf } from "../errors/message.ts"

export type { Variant } from "./generate/types.ts"
export { isVacuous } from "./generate/algebra.ts"

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
	/** The operation an overflow names; default "unknown". */
	operationId?: string
	/** Recursive schemas the document refers to as `oat-defs#/$defs/<name>`. */
	defs?: Record<string, Schema>
	/** Per-run token for values that must not collide with an earlier run's. */
	nonce?: string
	/** Top-level fields whose values must be distinct across runs too — the x-unique columns. */
	distinct?: ReadonlySet<string>
}

/**
 * The request schema as any writer may fill it: readOnly properties gone, and an optional property
 * marked x-privileged left out, since only the highest rank may set it (`ordinary`). Every body oat
 * makes or cuts from a record is read through this.
 */
export function ordinaryRequestSchema(schema: Schema | boolean): Schema | boolean {
	return typeof schema === "object" && schema !== null
		? normalizeSchema(schema, { direction: "request", ordinary: true })
		: schema
}

/* The request schema as generation reads it; one that cannot even be read is an overflow naming why. */
function readable(schema: Schema | boolean, operationId: string): Schema | boolean {
	try {
		return ordinaryRequestSchema(schema)
	} catch (error) {
		throw new FixtureOverflow(operationId, "/", `the schema could not be read: ${messageOf(error)}`)
	}
}

/** A cohort to build: the variants to make, default the whole `COHORT`, and how to make them. */
export interface CohortBuild extends CohortOptions {
	variants?: readonly Variant[]
}

/** One body per variant, each valid for the schema — or a `FixtureOverflow` naming what is not. */
export function buildCohort(bodySchema: Schema | boolean, seed: number, options: CohortBuild = {}): CohortMember[] {
	const { operationId = "unknown", variants = COHORT } = options
	const schema = readable(bodySchema, operationId)
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

/** Which body to draw: its variant, the random source, and its position in a cohort. */
export interface BodyDraw {
	variant: Variant
	rand: () => number
	index: number
}

/**
 * One body, with the required fields that could not be made rather than an exception — for
 * callers that report each gap themselves. Optional fields that cannot be made are left out.
 */
export function generateBody(
	bodySchema: Schema | boolean,
	draw: BodyDraw,
): { body: Record<string, unknown>; missingRequired: string[] } {
	const schema = ordinaryRequestSchema(bodySchema)
	const { index, rand, variant } = draw
	const result = generate(schema, { index, rand, variant })
	if (result.ok) return { body: isObject(result.value) ? result.value : {}, missingRequired: [] }
	/*
	 * Without the failing field, the rest may still be made: drop it from `required` and retry. Only a
	 * field this level declares can be dropped; one required through `allOf` would fail the same way
	 * on every retry. (A required field nothing declares is always made, so it never fails here.)
	 */
	const field = result.pointer.split("/")[1]
	if (
		field !== undefined &&
		typeof schema === "object" &&
		isObject(schema.properties) &&
		Object.hasOwn(schema.properties, field)
	) {
		const required = Array.isArray(schema.required) ? schema.required.filter((name) => name !== field) : []
		const properties = { ...schema.properties }
		delete properties[field]
		const rest = generateBody({ ...schema, properties, required }, draw)
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
/** What a member's unique columns are redrawn from: the body schema, and how cohort values are made. */
export interface Redrawing extends CohortOptions {
	schema: Schema | boolean
}

export function ensureDistinctUniqueValues(
	members: CohortMember[],
	sets: string[][],
	{ schema, ...options }: Redrawing,
): { members: CohortMember[]; gap: string | null } {
	if (sets.length === 0 || members.length <= 1) return { gap: null, members }
	const normalized = ordinaryRequestSchema(schema)
	const properties = typeof normalized === "object" && isObject(normalized.properties) ? normalized.properties : {}
	const kept: CohortMember[] = []
	for (const member of members) {
		const body = distinctBody(member, sets, { kept, options, properties })
		if (body !== undefined) kept.push({ body, variant: member.variant })
	}
	/* The first member is always kept: there is nothing before it to collide with. */
	if (kept.length === members.length) return { gap: null, members: kept }
	return { gap: uniqueDistinctGap(sets), members: kept }
}

/** What redrawing a member's unique columns needs: the members kept so far and the column schemas. */
interface Redraw {
	kept: readonly CohortMember[]
	options: CohortOptions
	properties: Record<string, unknown>
}

/** `member`'s body made distinct from every kept member on every set, or `undefined` if it cannot be. */
function distinctBody(member: CohortMember, sets: string[][], redraw: Redraw): Record<string, unknown> | undefined {
	const body = { ...member.body }
	for (const set of sets) {
		redrawSet(body, set, redraw)
		if (collides(redraw.kept, body, set)) return undefined
	}
	return body
}

/** Redraws one column of `set` in `body`, at most 16 times, until no kept member shares its tuple. */
function redrawSet(body: Record<string, unknown>, set: string[], { kept, options, properties }: Redraw): void {
	for (let attempt = 0; collides(kept, body, set) && attempt < 16; attempt++) {
		const col = set.find((name) => Object.hasOwn(body, name) && isObject(properties[name]))
		if (col === undefined) return
		const redrawn = generate(
			{ properties: { [col]: properties[col] }, required: [col], type: "object" },
			{
				...(options.defs === undefined ? {} : { defs: options.defs }),
				distinct: new Set([col]),
				index: kept.length * 17 + attempt + 1,
				nonce: `${options.nonce ?? ""}${attempt}`,
			},
		)
		if (!redrawn.ok) return
		body[col] = (redrawn.value as Record<string, unknown>)[col]
	}
}

function collides(kept: readonly CohortMember[], body: Record<string, unknown>, set: string[]): boolean {
	return kept.some((prior) => sameUniqueTuple(prior.body, body, set))
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
