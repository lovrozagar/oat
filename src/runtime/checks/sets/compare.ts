import type { FilterQuery } from "../../../spec/render/filter-types.ts"
import type { SortValue } from "../../../spec/render/sort.ts"
import type { Record_ } from "../../world/records.ts"
import type { Listed } from "../core/context.ts"
import { conv, pageSize, type Query } from "../query/capabilities.ts"
import { ids, type ListResult } from "./list.ts"
import { memoTable, readSet, type SetRead } from "./read.ts"

/** A whole set in the shape of one listed page: `items` holds every record, `exchange` is the last page read. */
export type Listing = ListResult & { complete: boolean }

/**
 * A whole set, as a `Listing`. For checks written against a single page that reason about the
 * whole set; a refused page shows as the last exchange's status.
 */
export async function listAll(ctx: Listed, query: Query): Promise<Listing> {
	return toListing(await readListing(ctx, query, false))
}

/**
 * A repeat `listAll` that sees the collection as it is now, for `settlePair`. `null` when a page was
 * refused, so a refusal is not read as rows vanishing.
 */
export async function listAgain(ctx: Listed, query: Query): Promise<Listing | null> {
	const read = await readListing(ctx, query, true)
	return read.status === "ok" ? toListing(read) : null
}

function toListing(read: SetRead): Listing {
	return {
		complete: read.status === "ok" && read.complete,
		envelope: read.last.envelope,
		exchange: read.last.exchange,
		items: read.items,
	}
}

/** `readSet` for a query written as one page's: paging keys dropped, the order key taken apart. */
function readListing(ctx: Listed, query: Query, fresh: boolean): Promise<SetRead> {
	const c = conv(ctx)
	const extra: Query = {}
	let order: string | undefined
	for (const [key, value] of Object.entries(query)) {
		if (key === c.limit || key === c.page || key === c.offset || key === c.cursor) continue
		if (key === c.order) order = value === undefined ? undefined : String(value)
		else extra[key] = value
	}
	return readSet(ctx, extra, { ...(fresh ? { fresh: true } : {}), order })
}

/**
 * Collects a whole result set — `readSet`, shaped for the set-algebra checks. `null` when a page
 * was refused, so the caller reports the check unresolved rather than reading "refused" as "empty".
 */
export async function collectSet(
	ctx: Listed,
	requested: number,
	extra: FilterQuery = {},
	/* `fresh`: a repeat read that must see the collection as it is now, not as an earlier read saw it. */
	{ order, fresh = false }: { order?: SortValue | undefined; fresh?: boolean | undefined } = {},
): Promise<SetRead | null> {
	const read = await readSet(ctx, extra, { ...(fresh ? { fresh: true } : {}), order, size: requested })
	return read.status === "ok" ? read : null
}

/** A read's rows as a set: two reads of one collection agree on it unless the collection moved. */
export function membership(records: Record_[], identity: string): string {
	return ids(records, identity).sort().join(",")
}

/** Two reads that must hold the same rows. */
export interface ReadPair<T> {
	first: T
	second: T
}

/**
 * Two reads that must hold the same rows and do not. Read the first again: when the same read
 * now holds other rows, the collection is moving under the check — an append-only log the run
 * itself writes to — and that is no defect of ordering. When it holds still, read the second again
 * and compare that fresh pair; only a disagreement that survives it is the backend's.
 */
export async function settlePair<T extends { items: Record_[] }>(
	identity: string,
	{ first, second }: ReadPair<T>,
	again: { first: () => Promise<T | null>; second: () => Promise<T | null> },
): Promise<ReadPair<T> | "moving" | null> {
	if (membership(first.items, identity) === membership(second.items, identity)) return { first, second }
	const firstAgain = await again.first()
	if (firstAgain === null) return null
	if (membership(firstAgain.items, identity) !== membership(first.items, identity)) return "moving"
	const secondAgain = await again.second()
	if (secondAgain === null) return null
	if (membership(secondAgain.items, identity) !== membership(second.items, identity)) return "moving"
	return { first: firstAgain, second: secondAgain }
}

/**
 * Reads every term and asks whether they agree. A disagreement is read again: when any read now
 * holds other rows, another writer moved the collection between the reads (a record created after
 * one term was read and before the next), and that is no defect of the query. Only a disagreement
 * the fresh reads repeat is the backend's, and those fresh reads are what is returned.
 */
export async function readSettled(
	ctx: Listed,
	terms: ReadonlyArray<Record<string, string>>,
	agree: (reads: SetRead[]) => boolean,
): Promise<SetRead[] | "rejected" | "incomplete" | "moving"> {
	const limit = pageSize(ctx)
	const read = async (fresh: boolean): Promise<SetRead[] | "rejected" | "incomplete"> => {
		const reads: SetRead[] = []
		for (const term of terms) {
			const set = await collectSet(ctx, limit, term, { fresh })
			if (set === null) return "rejected"
			reads.push(set)
		}
		return reads.every((set) => set.complete) ? reads : "incomplete"
	}
	const first = await read(false)
	if (typeof first === "string" || agree(first)) return first
	const again = await read(true)
	if (typeof again === "string") return again
	/* Both reads cover the same terms, in order, so each term's rows are compared with its own. */
	const now = again.map((set) => membership(set.items, ctx.identity))
	const moved = first.some((set, i) => membership(set.items, ctx.identity) !== now[i])
	return moved ? "moving" : again
}

export function duplicates(values: string[]): string[] {
	const seen = new Set<string>()
	const dupes = new Set<string>()
	for (const value of values) {
		if (seen.has(value)) dupes.add(value)
		seen.add(value)
	}
	return [...dupes]
}

export function setOf(records: Record_[], identity: string): Set<string> {
	return new Set(ids(records, identity))
}

export function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const item of a) if (!b.has(item)) return false
	return true
}

/**
 * A fact about the seeded cohort — a tied sort field, a proper-subset filter, an overlapping
 * search token. The cohort is never written after seeding, so the answer cannot go stale; keyed
 * by list operation too, because a fact about one listing's capabilities is not one about another.
 */
export function cohortFact<T>(ctx: Listed, name: string, compute: () => T): T {
	const facts = memoTable<unknown>(ctx.memo.entity, "cohortFacts")
	const key = `${ctx.listOp.operationId}:${name}`
	if (facts.has(key)) return facts.get(key) as T
	const value = compute()
	facts.set(key, value)
	return value
}
