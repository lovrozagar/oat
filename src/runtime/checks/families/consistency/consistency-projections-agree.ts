import { defineCheck } from "../../core/define.ts"
import { filterTerm, selectTerm, sortTerm } from "../../../../spec/conventions.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { idOf, type Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord } from "../../isolation/scratch.ts"
import { itemParamFor, NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { list, type ListResult } from "../../sets/list.ts"

/**
 * One fact, asserted through every projection that can express it.
 *
 * Every other check judges a projection against an expectation: does `filter` narrow, does
 * `select` project, does the detail route serve what was written. Each can pass while the
 * projections still contradict *each other* — the detail route says "active", the listing says
 * "pending", the filtered query returns the record for both. Nothing in a per-projection check
 * notices, because each one is individually defensible.
 *
 * So this reads a single field of a single record through the item route, the collection, a
 * sparse fieldset, an equality filter, its negation, and a sorted page, and requires them to
 * agree. It cannot say which projection is wrong — only that at least one is, which is the
 * honest claim and enough to act on. Where they disagree the report names every projection and
 * what each returned, so the odd one out is visible at a glance.
 *
 * This is the criss-cross property: a fact is not "in the database", it is whatever each read
 * path says it is, and a system is only consistent if they say the same thing.
 */
export const projectionsAgree = defineCheck<{
	id: string
	field: string
	target: Record_
	readOp: OperationModel
}>({
	plan: (ctx) => {
		const target = ctx.records[0]
		const readOp = ctx.readOp
		if (target === undefined || readOp === undefined) return cannot()
		/*
		 * A filterable, sortable, non-null, *client-owned* field.
		 *
		 * Server-generated fields are excluded deliberately: a progress counter, a derived row
		 * count or a status the backend advances can legitimately differ between two reads taken
		 * moments apart, and since oat tests entities concurrently a derived value may move
		 * mid-check for reasons no read path is responsible for. Comparing those across
		 * projections measures timing, not consistency.
		 */
		const generated = new Set([...(ctx.createOp?.generated ?? []), ...(ctx.updateOp?.generated ?? [])])
		const field = (ctx.query?.filterable ?? []).find(
			(name) =>
				name !== ctx.identity &&
				!generated.has(name) &&
				(ctx.query?.sortable ?? []).includes(name) &&
				target[name] !== null &&
				target[name] !== undefined &&
				typeof target[name] !== "object",
		)
		if (field === undefined) return cannot("a client-owned field that is filterable, sortable and set on a record")
		const id = idOf(target, ctx.identity)
		return id === undefined ? cannot(NO_IDENTITY) : ready({ field, id, readOp, target })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"pagination.page-walk-covers-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		/* Each projection is exercised elsewhere. When one is already known broken, its
		 * disagreement here is that same defect seen a second time. */
		"filter.equality-selects-exactly-one",
		"select.projection-honoured",
		"select.requested-fields-present",
		"sort.order-is-applied",
	],
	id: "consistency.projections-agree",
	needs: "an item route and a record with a comparable field",
	subjects: subjectsOf.readAndList,
	async run(ctx, { field, id, readOp }): Promise<Outcome> {
		const detail = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
		if (detail.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the item route returned ${detail.status}, leaving no reference value to compare against`,
			)
		}
		/*
		 * The item route read *now* is the reference, not the value oat submitted at seed time.
		 * A backend is entitled to normalise what it stores — trimming, case-folding, rounding —
		 * and holding every projection to the submitted value would report that as inconsistency.
		 * The claim being tested is that the read paths agree with each other, which is exactly
		 * what anchoring on one of them and comparing the rest establishes.
		 */
		const value = readRecord(readOp, detail)?.[field]
		const { plain, seen } = await readProjections(ctx, field, id)

		const disagreeing = seen.filter((entry) => JSON.stringify(entry.value) !== JSON.stringify(value))
		if (disagreeing.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"the same record carries different values depending on how it is read",
				`${ctx.entityName} ${id} has "${field}" = ${JSON.stringify(value)} on the record oat ` +
					`created, but ${disagreeing
						.map((entry) => `the ${entry.projection} returns ${JSON.stringify(entry.value)}`)
						.join(", and ")}. At least one read path is serving something the others are not; ` +
					"a client's view of a record then depends on which route it happened to use.",
				[detail, plain.exchange],
			)
		}
		return filterMembership(ctx, this.id, { detail, field, id, value })
	},
})

/** What one projection returned for the field. */
interface Seen {
	projection: string
	value: unknown
}

/**
 * The field as the collection, a sparse fieldset and a sorted page each return it. A projection
 * the record does not appear on says nothing, so it adds no entry.
 */
async function readProjections(
	ctx: CheckContext,
	field: string,
	id: string,
): Promise<{ plain: ListResult; seen: Seen[] }> {
	const limit = pageSize(ctx)
	const seen: Seen[] = []
	const record = (result: ListResult): Record_ | undefined =>
		result.items.find((item) => idOf(item, ctx.identity) === id)

	const plain = await list(ctx, q(ctx, { limit }))
	const inList = record(plain)
	if (inList !== undefined) seen.push({ projection: "collection", value: inList[field] })

	const conventions = conv(ctx)
	/* `null` exactly when the endpoint has no sparse-fieldset parameter. */
	const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
	if (projection !== null) {
		const row = record(await list(ctx, { ...q(ctx, { limit }), ...projection }))
		if (row !== undefined) seen.push({ projection: "sparse fieldset", value: row[field] })
	}

	if (conventions.order !== undefined) {
		const sorted = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
		const row = record(sorted)
		if (row !== undefined) seen.push({ projection: "sorted page", value: row[field] })
	}
	return { plain, seen }
}

/** The filter projection: an equality filter on the value the item route serves must return the record. */
async function filterMembership(
	ctx: CheckContext,
	check: string,
	probe: { detail: Exchange; field: string; id: string; value: unknown },
): Promise<Outcome> {
	const { detail, field, id, value } = probe
	/* Membership is a projection too: a filter that matches the value must return the record,
	 * its negation must not, and both are read off the same fact just proven consistent.
	 * Equality says nothing about null — whether `eq` matches a null is the backend's
	 * convention, not a contract — so a null value has no membership to test. */
	if (value === null || value === undefined) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`"${field}" is null on the item route, and equality is not defined for null`,
		)
	}
	const matching = filterTerm(conv(ctx), field, "eq", String(value))
	if (matching === null) return standDown("the filter grammar cannot express this probe")
	/* The whole filtered set, not its first page: absence from one page proves nothing. */
	const included = await collectSet(ctx, pageSize(ctx), matching)
	if (included === null) {
		return ctx.findings.unresolved(check, ctx.entityName, `filtering on "${field}" was rejected`)
	}
	if (included.items.some((item) => idOf(item, ctx.identity) === id)) return ASSERTED
	if (!included.complete) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			"the filtered set is larger than the walk covers, so the record's absence is not established",
		)
	}

	return ctx.findings.backend(
		check,
		ctx.entityName,
		"a record is missing from a filter matching its own field value",
		`${ctx.entityName} ${id} carries "${field}" = ${JSON.stringify(value)} on every read path, ` +
			`yet filtering for exactly that value does not return it. The record and the predicate ` +
			"agree; the index or query that answers the filter does not.",
		[detail, included.last.exchange],
	)
}
