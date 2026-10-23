/*
 * The `{name}` placeholders a chain of login or refresh steps reads, and the names it binds. The
 * step runner fills each from the chain's scope: what the chain started from, then what each
 * step's `bind`, `saveAs`, `saveClaimsFrom` and out-of-band `as` bound before it. A name nothing
 * fills would be sent as written, so a recipe that reads one is refused, by name: at load, and
 * before a request leaves. `{principal.<key>}` is the principal's identity, filled apart.
 */

import { isRaw, isRawUnion, isRecord, type RawOf, type RawOfUnion } from "../config/types/raw.ts"
import type { AuthStep, OutOfBandStep, RequestStep } from "../config/types/steps.ts"

type Step = RawOfUnion<AuthStep>

/** A `{name}` a step reads that nothing before it fills: the step, counted from 1, and the name. */
export interface Unfilled {
	step: number
	name: string
}

/* A map the user keys, such as `bind` or `saveAs`; empty when it is not one. */
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
const stepOf = (value: unknown): Step => (isRawUnion<AuthStep>(value) ? value : {})
const outOfBandOf = (step: Step): RawOf<OutOfBandStep["outOfBand"]> =>
	isRaw<OutOfBandStep["outOfBand"]>(step.outOfBand) ? step.outOfBand : {}
const claimsOf = (step: Step): RawOf<NonNullable<RequestStep["saveClaimsFrom"]>> =>
	isRaw<NonNullable<RequestStep["saveClaimsFrom"]>>(step.saveClaimsFrom) ? step.saveClaimsFrom : {}

/** Every `{name}` in the text of a value, deep through arrays and plain objects, in order. */
function namesIn(value: unknown): string[] {
	if (typeof value === "string") return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(([, name]) => String(name))
	if (Array.isArray(value)) return value.flatMap(namesIn)
	return isRecord(value) ? Object.values(value).flatMap(namesIn) : []
}

/* What a step's request reads: a raw step's path, and its body, headers and query. An operation's path is the document's. */
function requestReads(step: Step): string[] {
	if (step.outOfBand !== undefined) return namesIn(outOfBandOf(step).address)
	return namesIn([step.method === undefined ? null : step.path, step.body, step.headers, step.query])
}

/* Each `[name, template]` binding of a map, in order: a template may read the names bound before it. */
function bindingsOf(value: unknown): Array<[string, unknown]> {
	return Object.entries(recordOf(value))
}

/** The first placeholder in `steps` that neither `given` nor an earlier binding fills. */
export function unfilledIn(steps: readonly unknown[], given: Iterable<string>): Unfilled | undefined {
	const bound = new Set(given)
	const missing = (value: unknown): string | undefined => namesIn(value).find((name) => !bound.has(name))
	for (const [index, value] of steps.entries()) {
		const step = stepOf(value)
		const name = unfilledStep(step, { bound, missing })
		if (name !== undefined) return { name, step: index + 1 }
	}
	return undefined
}

/* One step in the engine's order: its binds, its request, its saveAs addresses, then its claims and out-of-band value. */
function unfilledStep(
	step: Step,
	at: { bound: Set<string>; missing: (value: unknown) => string | undefined },
): string | undefined {
	const { bound, missing } = at
	for (const [name, template] of bindingsOf(step.bind)) {
		const read = missing(template)
		if (read !== undefined) return read
		bound.add(name)
	}
	const read = requestReads(step).find((name) => !bound.has(name))
	if (read !== undefined) return read
	for (const [name, address] of bindingsOf(step.saveAs)) {
		const unread = missing(address)
		if (unread !== undefined) return unread
		bound.add(name)
	}
	for (const name of boundAfter(step)) bound.add(name)
	return undefined
}

/* What a step binds once it is answered, beside `saveAs`: its claims, or the out-of-band value. */
function boundAfter(step: Step): string[] {
	const out = outOfBandOf(step)
	return [...Object.keys(recordOf(claimsOf(step).bind)), ...(typeof out.as === "string" ? [out.as] : [])]
}

/** Every name a chain of steps binds: what a refresh after it may read. */
export function capturedBy(steps: readonly unknown[]): Set<string> {
	return new Set(
		steps.flatMap((value) => {
			const step = stepOf(value)
			return [...Object.keys(recordOf(step.bind)), ...Object.keys(recordOf(step.saveAs)), ...boundAfter(step)]
		}),
	)
}
