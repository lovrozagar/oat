/**
 * The check registry.
 *
 * Each check asserts one property that must hold for any correct implementation. They need no
 * ground truth — they compare the API against itself, through independent projections, or against
 * the oracle of what oat just wrote. Check ids are stable: the conformance suite asserts on them.
 */

import type { QueryCapability } from "../spec/extensions.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import { buildCohort } from "./fixture.ts"
import type { SchemaValidator } from "./validate.ts"
import { type Record_, fillPath } from "./world.ts"

export interface CheckContext {
	entityName: string
	identity: string
	model: SpecModel
	client: Client
	findings: FindingCollector
	scope: Record<string, string>
	listOp: OperationModel
	readOp: OperationModel | undefined
	createOp: OperationModel | undefined
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
	collectionKey: string | null
	records: Record_[]
	query: QueryCapability | null
	softDelete: string | null
	auth: () => Record<string, string>
	/** Second principal in a different tenant, when one is configured. */
	altAuth: (() => Record<string, string>) | undefined
	altScope: Record<string, string> | undefined
	validator: SchemaValidator | undefined
	seed: number
}

export interface Check {
	id: string
	/** Skipped silently when the entity lacks the operations this check needs. */
	applicable: (ctx: CheckContext) => boolean
	/**
	 * Check ids whose failure makes this one's result meaningless. When any has already fired for
	 * this entity, the check is skipped rather than reporting a consequence as a separate defect —
	 * one root cause should produce one finding, not a page of them.
	 */
	dependsOn?: string[]
	run: (ctx: CheckContext) => Promise<void>
}

/* ------------------------------------------------------------------- helpers */

interface ListResult {
	items: Record_[]
	envelope: Record<string, unknown>
	exchange: Exchange
}

async function list(
	ctx: CheckContext,
	query: Record<string, string | number | undefined> = {},
	auth = ctx.auth,
	scope = ctx.scope,
): Promise<ListResult> {
	const exchange = await ctx.client.get(fillPath(ctx.listOp.path, scope), {
		headers: auth(),
		query,
	})
	const body = exchange.responseBody
	const items = extractItems(body, ctx.collectionKey)
	return { envelope: (body ?? {}) as Record<string, unknown>, exchange, items }
}

function extractItems(body: unknown, key: string | null): Record_[] {
	if (Array.isArray(body)) return body as Record_[]
	if (body === null || typeof body !== "object") return []
	if (key !== null) {
		const value = (body as Record<string, unknown>)[key]
		return Array.isArray(value) ? (value as Record_[]) : []
	}
	return []
}

function ids(records: Record_[], identity: string): string[] {
	return records.map((r) => String(r[identity]))
}

/** Walks every page, returning the ids in encounter order (duplicates preserved). */
async function walkPages(ctx: CheckContext, pageSize: number, order?: string): Promise<string[]> {
	const seen: string[] = []
	for (let page = 1; page <= 50; page++) {
		const result = await list(ctx, { limit: pageSize, order, page })
		seen.push(...ids(result.items, ctx.identity))
		const hasMore = result.envelope.hasMore
		if (hasMore !== true || result.items.length === 0) break
	}
	return seen
}

async function walkCursor(ctx: CheckContext, pageSize: number, order?: string): Promise<string[]> {
	const seen: string[] = []
	let cursor: string | undefined
	for (let hop = 0; hop < 50; hop++) {
		const result = await list(ctx, { cursor, limit: pageSize, order })
		seen.push(...ids(result.items, ctx.identity))
		const next = result.envelope.nextCursor
		if (typeof next !== "string" || next === "" || result.items.length === 0) break
		cursor = next
	}
	return seen
}

/**
 * Whether a result is the complete set rather than a truncated page.
 *
 * Deliberately does not trust `hasMore`: checks that reason about set algebra must stay correct
 * on a backend whose more-pages flag is itself broken, or one defect masquerades as another. A
 * page returning fewer records than it asked for cannot have been truncated.
 */
function isComplete(result: ListResult, requestedLimit: number): boolean {
	if (result.envelope.hasMore === true) return false
	return result.items.length < requestedLimit
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>()
	const dupes = new Set<string>()
	for (const value of values) {
		if (seen.has(value)) dupes.add(value)
		seen.add(value)
	}
	return [...dupes]
}

/**
 * A sortable field whose values repeat across the cohort. Ties are what expose an unstable sort:
 * with distinct keys every implementation looks correct, because there is only one valid order.
 */
function tiedSortField(ctx: CheckContext): string | null {
	for (const field of ctx.query?.sortable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => JSON.stringify(r[field]))
		if (new Set(values).size < values.length) return field
	}
	return null
}

/**
 * A field that is null on some seeded records and populated on others.
 *
 * Null handling is where query engines break — SQL's three-valued logic means `col <> x` is NULL
 * rather than true for null rows, so they silently vanish from negated predicates, and
 * nullsfirst/nullslast is easy to get backwards. A check that only ever probes the identity
 * column, which is never null, cannot see any of it.
 */
function nullableField(ctx: CheckContext, candidates: readonly string[]): string | null {
	for (const field of candidates) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => r[field])
		const nulls = values.filter((v) => v === null || v === undefined).length
		if (nulls > 0 && nulls < values.length) return field
	}
	return null
}

function firstFilterable(ctx: CheckContext, predicate: (name: string) => boolean): string | null {
	const candidates = ctx.query?.filterable ?? []
	return candidates.find(predicate) ?? null
}

/* -------------------------------------------------------------------- checks */

const readAfterWrite: Check = {
	applicable: (ctx) => ctx.createOp !== undefined && ctx.records.length > 0,
	id: "list.read-after-write",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const pageSize = ctx.query?.maxLimit ?? 100
		const full = await list(ctx, { limit: pageSize })
		if (full.items.some((item) => String(item[ctx.identity]) === id)) return

		/* Absent from the first page is not absent from the collection — a cohort larger than
		 * maxLimit spans several pages. Confirm across the whole walk before calling it missing,
		 * or every capped collection reports a phantom lost write. */
		if (full.envelope.hasMore === true && (await walkPages(ctx, pageSize)).includes(id)) return

		/* A record that appears on a repeat request was never lost — it was unreachable for one
		 * query. That is an ordering defect, which the pagination checks diagnose precisely;
		 * reporting it here as a lost write would name the wrong cause. This check is about
		 * records the list *never* shows. */
		for (let attempt = 0; attempt < 2; attempt++) {
			const retry = await list(ctx, { limit: pageSize })
			if (retry.items.some((item) => String(item[ctx.identity]) === id)) return
			if (retry.envelope.hasMore === true && (await walkPages(ctx, pageSize)).includes(id)) return
		}

		const evidence: Exchange[] = [full.exchange]
		let detail = `created ${ctx.entityName} ${id} is absent from the list projection`
		if (ctx.readOp !== undefined) {
			const item = await ctx.client.get(
				fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }),
				{ headers: ctx.auth() },
			)
			evidence.push(item)
			if (item.status < 300) {
				detail =
					`created ${ctx.entityName} ${id} is served by the item route (${item.status}) but ` +
					"does not appear in the list route — the two projections disagree"
			}
		}
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"list projection does not reflect a completed write",
			detail,
			evidence,
		)
	},
}

function itemParamFor(ctx: CheckContext, id: string): Record<string, string> {
	const op = ctx.readOp ?? ctx.updateOp ?? ctx.deleteOp
	const param = op?.pathParams.at(-1)
	return param === undefined ? {} : { [param]: id }
}

const unknownFilterRejected: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("filter"),
	id: "filter.unknown-field-rejected",
	async run(ctx) {
		const baseline = await list(ctx, { limit: 100 })
		const result = await list(ctx, {
			filter: "oat_no_such_field_xyz.eq.1",
			limit: 100,
		})

		if (result.exchange.status >= 500) {
			ctx.findings.backend(
				"error.malformed-filter-not-5xx",
				ctx.entityName,
				"unknown filter field produces a server error",
				`filtering on an undeclared field returned ${result.exchange.status}; a rejected input ` +
					"should be a 4xx",
				[result.exchange],
			)
			return
		}
		if (result.exchange.status >= 400) return

		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown filter field is silently ignored",
			`filtering on an undeclared field returned ${result.exchange.status} with ` +
				`${result.items.length} of ${baseline.items.length} records` +
				(same ? " — identical to the unfiltered result, so the filter was dropped entirely" : "") +
				". A filter the backend does not understand must be rejected, never ignored: silently " +
				"ignoring it means every caller's filter may be doing nothing.",
			[baseline.exchange, result.exchange],
		)
	},
}

const equalityFilterSelectsOne: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("filter") &&
		ctx.records.length > 0 &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: ["list.read-after-write"],
	id: "filter.equality-selects-exactly-one",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const result = await list(ctx, { filter: `${ctx.identity}.eq.${id}`, limit: 100 })
		const got = ids(result.items, ctx.identity)
		if (got.length === 1 && got[0] === id) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"equality filter on the identity does not select exactly one record",
			`filter=${ctx.identity}.eq.${id} returned ${got.length} records (${got.slice(0, 5).join(", ")})`,
			[result.exchange],
		)
	},
}

const zeroMatchFilter: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("filter") &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: ["list.read-after-write"],
	id: "filter.zero-match-returns-none",
	async run(ctx) {
		const result = await list(ctx, {
			filter: `${ctx.identity}.eq.oat-nonexistent-value-000`,
			limit: 100,
		})
		if (result.exchange.status >= 400) return
		if (result.items.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"filter that cannot match returns records anyway",
			`a filter on a value no record holds returned ${result.items.length} records, so the ` +
				"predicate is not being applied",
			[result.exchange],
		)
	},
}

const negationPartitions: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("filter") &&
		ctx.records.length > 1 &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: ["list.read-after-write"],
	id: "filter.negation-partitions-the-set",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		/* Prefer a field with nulls in the cohort: partitioning on the identity can never expose
		 * three-valued-logic bugs, because an identity is never null. */
		const field = nullableField(ctx, ctx.query?.filterable ?? []) ?? ctx.identity
		const probe = ctx.records.map((r) => r[field]).find((v) => v !== null && v !== undefined)
		if (probe === undefined) return
		const value = String(probe)
		const limit = ctx.query?.maxLimit ?? 100
		const all = await list(ctx, { limit })
		const matching = await list(ctx, { filter: `${field}.eq.${value}`, limit })
		const complement = await list(ctx, { filter: `${field}.neq.${value}`, limit })
		if ([all, matching, complement].some((r) => r.exchange.status >= 400)) return
		/* Set algebra only holds over complete sets. If any of the three results is a truncated
		 * page, the union can legitimately miss records that simply fell off the end. */
		if ([all, matching, complement].some((r) => !isComplete(r, limit))) return

		const union = new Set([
			...ids(matching.items, ctx.identity),
			...ids(complement.items, ctx.identity),
		])
		const expected = new Set(ids(all.items, ctx.identity))
		const overlap = ids(matching.items, ctx.identity).filter((value) =>
			ids(complement.items, ctx.identity).includes(value),
		)

		if (overlap.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a predicate and its negation both match the same record",
				`${overlap.length} record(s) appear in both ${field}.eq and ${field}.neq results: ` +
					overlap.slice(0, 3).join(", "),
				[matching.exchange, complement.exchange],
			)
			return
		}
		const missing = [...expected].filter((id) => !union.has(id))
		if (missing.length > 0) {
			const nulls = missing.filter((id) => {
				const record = ctx.records.find((r) => String(r[ctx.identity]) === id)
				return record !== undefined && (record[field] === null || record[field] === undefined)
			})
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a predicate and its negation do not cover the full set",
				`${missing.length} record(s) match neither ${field}.eq nor ${field}.neq: ` +
					`${missing.slice(0, 3).join(", ")}. ` +
					(nulls.length === missing.length
						? `Every one of them has ${field} = null, so the negated predicate is dropping ` +
							"nulls — SQL evaluates `col <> x` as NULL, not true, unless the query also " +
							"tests `col IS NULL`."
						: "A record must satisfy either a predicate or its negation."),
				[all.exchange, matching.exchange, complement.exchange],
			)
		}
	},
}

const sortReverseSymmetry: Check = {
	applicable: (ctx) => (ctx.query?.sortable.length ?? 0) > 0 && ctx.records.length > 1,
	id: "sort.reverse-symmetry",
	async run(ctx) {
		/* A nullable sort key exercises null ordering, where the interesting bugs live. */
		const field =
			nullableField(ctx, ctx.query?.sortable ?? []) ??
			ctx.query?.sortable.find((f) => f !== ctx.identity) ??
			ctx.query?.sortable[0]
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const ascending = await list(ctx, { limit, order: `${field}.asc` })
		const descending = await list(ctx, { limit, order: `${field}.desc` })
		if (ascending.exchange.status >= 400 || descending.exchange.status >= 400) return

		/* Only comparable when a single page holds the whole collection. Otherwise asc and desc
		 * return opposite *windows* of it — legitimately different sets, and comparing them would
		 * report every capped collection as broken. */
		if (!isComplete(ascending, limit) || !isComplete(descending, limit)) return

		const forward = ids(ascending.items, ctx.identity)
		const backward = ids(descending.items, ctx.identity)
		if (forward.length !== backward.length) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"ascending and descending sorts return different numbers of records",
				`order=${field}.asc returned ${forward.length}, order=${field}.desc returned ${backward.length}`,
				[ascending.exchange, descending.exchange],
			)
			return
		}
		if (forward.join(",") === [...backward].reverse().join(",")) return

		/* Values may legitimately tie; only flag when the multisets differ or a strict field
		 * ordering is violated, not when equal keys land in a different arrangement. */
		const sameSet = [...forward].sort().join(",") === [...backward].sort().join(",")
		if (!sameSet) {
			const onlyAsc = forward.filter((id) => !backward.includes(id))
			const onlyDesc = backward.filter((id) => !forward.includes(id))
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"ascending and descending sorts return different sets",
				`order=${field}.asc and order=${field}.desc disagree about which records exist. ` +
					`Only ascending: ${onlyAsc.slice(0, 3).join(", ") || "—"}. ` +
					`Only descending: ${onlyDesc.slice(0, 3).join(", ") || "—"}. ` +
					"Sort direction must reorder a collection, never change its membership.",
				[ascending.exchange, descending.exchange],
			)
		}
	},
}

const pageWalkCoversSet: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("page") && ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"pagination.limit-bounds-page-size",
		"pagination.has-more-is-accurate",
	],
	id: "pagination.page-walk-covers-set",
	async run(ctx) {
		const limit = ctx.query?.maxLimit ?? 100
		/* Walk under a low-cardinality sort. Distinct keys admit exactly one valid order, so an
		 * unstable sort is indistinguishable from a correct one until values tie. */
		const order = tiedSortField(ctx)
		const orderParam = order === null ? undefined : `${order}.asc`
		const single = await list(ctx, { limit, order: orderParam })
		const walked = await walkPages(ctx, 2, orderParam)
		const expected = ids(single.items, ctx.identity)

		const repeated = duplicates(walked)
		if (repeated.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"paging returns the same record on more than one page",
				`walking at limit=2 returned ${repeated.length} duplicated id(s): ${repeated.slice(0, 3).join(", ")}. ` +
					"This is the signature of a sort without a total order — the page boundary is not stable.",
				[single.exchange],
			)
			return
		}
		const missing = expected.filter((id) => !walked.includes(id))
		if (missing.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"paging skips records that a single large page returns",
				`a single page at limit=${limit} returned ${expected.length} records, but walking at ` +
					`limit=2 yielded ${walked.length} and missed ${missing.length}: ${missing.slice(0, 3).join(", ")}`,
				[single.exchange],
			)
			return
		}

		/* Instability is probabilistic: one walk can come out intact by luck. Two identical walks
		 * must agree, so comparing them tests the ordering guarantee directly rather than waiting
		 * for a dropped row to happen to appear. */
		const second = await walkPages(ctx, 2, orderParam)
		if (second.join(",") === walked.join(",")) return
		const sameSet = [...second].sort().join(",") === [...walked].sort().join(",")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			sameSet
				? "identical page walks return records in different orders"
				: "identical page walks return different records",
			`walking the collection twice with the same parameters` +
				(orderParam === undefined ? "" : ` (order=${orderParam})`) +
				` produced ${sameSet ? "the same records in a different order" : "different sets"}. ` +
				"Pagination requires a total order; without a tiebreak the page boundary moves between " +
				"requests and callers silently miss or repeat rows.",
			[single.exchange],
		)
	},
}

const cursorAgreesWithPage: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("cursor") &&
		ctx.listOp.queryParamNames.includes("page") &&
		ctx.records.length > 2,
	dependsOn: ["pagination.page-walk-covers-set"],
	id: "pagination.cursor-agrees-with-page",
	async run(ctx) {
		const byPage = await walkPages(ctx, 2)
		const byCursor = await walkCursor(ctx, 2)

		/* Repeats are their own defect: a cursor that resolves to the wrong boundary re-serves the
		 * previous page's tail, which set comparison alone would hide. */
		const repeated = duplicates(byCursor).filter((id) => !duplicates(byPage).includes(id))
		if (repeated.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"cursor pagination re-serves records the previous page already returned",
				`walking by cursor returned ${repeated.length} record(s) more than once ` +
					`(${repeated.slice(0, 3).join(", ")}) while the offset walk returned each exactly once. ` +
					"The cursor is resolving to the wrong boundary.",
				[],
			)
			return
		}

		const pageSet = [...new Set(byPage)].sort()
		const cursorSet = [...new Set(byCursor)].sort()
		if (pageSet.join(",") === cursorSet.join(",")) return

		const onlyPage = pageSet.filter((id) => !cursorSet.includes(id))
		const onlyCursor = cursorSet.filter((id) => !pageSet.includes(id))
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"cursor pagination and offset pagination disagree",
			`offset walk yielded ${pageSet.length} distinct records, cursor walk yielded ${cursorSet.length}. ` +
				`Only in offset: ${onlyPage.slice(0, 3).join(", ") || "—"}. ` +
				`Only in cursor: ${onlyCursor.slice(0, 3).join(", ") || "—"}. ` +
				"Both traverse the same collection, so one of them is losing or repeating rows.",
			[],
		)
	},
}

const countMatchesWalk: Check = {
	applicable: (ctx) => ctx.records.length > 1 && ctx.listOp.queryParamNames.includes("filter"),
	dependsOn: ["list.read-after-write"],
	id: "count.matches-filtered-set",
	async run(ctx) {
		if (!(ctx.query?.filterable.includes(ctx.identity) ?? false)) return
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const filtered = await list(ctx, { filter: `${ctx.identity}.eq.${id}`, limit: 100 })
		if (filtered.exchange.status >= 400) return
		const reported = filtered.envelope.count
		if (typeof reported !== "number") return
		if (reported === filtered.items.length) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"reported count disagrees with the filtered result",
			`filter selected ${filtered.items.length} record(s) but count reported ${reported}. ` +
				"A count that ignores the active filter makes every paginated UI show wrong totals.",
			[filtered.exchange],
		)
	},
}

const selectProjection: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("select") && ctx.records.length > 0,
	id: "select.projection-honoured",
	async run(ctx) {
		const requested = [ctx.identity]
		const extra = ctx.query?.selectable.find((f) => f !== ctx.identity)
		if (extra !== undefined) requested.push(extra)

		const result = await list(ctx, { limit: 5, select: requested.join(",") })
		if (result.exchange.status >= 400 || result.items.length === 0) return
		const first = result.items[0]
		if (first === undefined) return
		const returned = Object.keys(first)
		const unexpected = returned.filter((key) => !requested.includes(key))
		if (unexpected.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"sparse fieldset is accepted but ignored",
			`select=${requested.join(",")} returned ${returned.length} fields, including ` +
				`${unexpected.slice(0, 5).join(", ")}. Accepting a projection and ignoring it silently ` +
				"inflates every response and leaks fields a caller deliberately excluded.",
			[result.exchange],
		)
	},
}

const patchMinimality: Check = {
	applicable: (ctx) => ctx.updateOp !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
	id: "patch.minimality",
	async run(ctx) {
		const target = ctx.records.find((r) => Object.values(r).some((v) => typeof v === "string"))
		if (target === undefined || ctx.updateOp === undefined || ctx.readOp === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const before = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		if (before.status >= 300) return
		const original = (before.responseBody ?? {}) as Record_

		const field = pickWritableStringField(ctx, original)
		if (field === null) return

		const patched = await ctx.client.request("PATCH", fillPath(ctx.updateOp.path, params), {
			body: { [field]: "oat patched value" },
			headers: ctx.auth(),
		})
		if (patched.status >= 300) return

		const after = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		const current = (after.responseBody ?? {}) as Record_

		const collateral = Object.keys(original).filter((key) => {
			if (key === field || key === "updated_at" || key === "modified_at") return false
			return JSON.stringify(original[key]) !== JSON.stringify(current[key])
		})
		if (collateral.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"PATCH changed fields the request did not mention",
			`patching only "${field}" also changed ${collateral.length} other field(s): ` +
				collateral
					.slice(0, 5)
					.map((key) => `${key} ${JSON.stringify(original[key])} → ${JSON.stringify(current[key])}`)
					.join("; ") +
				". PATCH is a partial update; behaving as PUT silently destroys data callers never sent.",
			[before, patched, after],
		)
	},
}

function pickWritableStringField(ctx: CheckContext, record: Record_): string | null {
	const immutable = new Set([...(ctx.updateOp?.immutable ?? []), ...(ctx.updateOp?.generated ?? [])])
	for (const [key, value] of Object.entries(record)) {
		if (immutable.has(key) || key === ctx.identity) continue
		if (/_at$|_id$/.test(key)) continue
		if (typeof value === "string" && value !== "") return key
	}
	return null
}

const immutableRejected: Check = {
	applicable: (ctx) =>
		ctx.updateOp !== undefined && ctx.readOp !== undefined && (ctx.updateOp.immutable.length > 0) && ctx.records.length > 0,
	id: "patch.immutable-field-rejected",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.updateOp === undefined || ctx.readOp === undefined) return
		const field = ctx.updateOp.immutable.find((f) => f !== ctx.identity) ?? ctx.updateOp.immutable[0]
		if (field === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const probe = "oat-immutable-probe"
		const patched = await ctx.client.request("PATCH", fillPath(ctx.updateOp.path, params), {
			body: { [field]: probe },
			headers: ctx.auth(),
		})
		if (patched.status >= 400) return

		/* Read the echoed record first. Re-reading can itself fail once the write lands — writing
		 * a tenant key, for instance, moves the record out of the caller's scope — and that
		 * failure would otherwise mask the very defect being probed. */
		const echoed = (patched.responseBody ?? {}) as Record_
		const after = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		const current = (after.responseBody ?? {}) as Record_
		const accepted = echoed[field] === probe || current[field] === probe
		if (!accepted) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a field declared immutable accepted a write",
			`PATCH set "${field}" to a client-supplied value and the change persisted. ` +
				"Server-owned fields must reject writes, not absorb them.",
			[patched, after],
		)
	},
}

const likeEscaping: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("filter") && ctx.records.length > 1,
	id: "filter.like-metacharacters-escaped",
	async run(ctx) {
		const field = firstFilterable(ctx, (name) => (ctx.query?.searchable ?? []).includes(name))
		if (field === null) return
		const total = await list(ctx, { limit: 100 })
		/* A literal `%` is not a wildcard in this grammar — `*` is. Matching everything means the
		 * value was interpolated into a LIKE pattern unescaped. */
		const probe = await list(ctx, { filter: `${field}.like.%`, limit: 100 })
		if (probe.exchange.status >= 400) return
		if (probe.items.length < total.items.length || total.items.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"LIKE metacharacters in a filter value are not escaped",
			`filter=${field}.like.%25 matched all ${probe.items.length} records. "%" is a literal in ` +
				"this grammar; treating it as a wildcard means user input is being interpolated into a " +
				"pattern unescaped.",
			[total.exchange, probe.exchange],
		)
	},
}

const createStatusMatchesSpec: Check = {
	applicable: (ctx) => ctx.createOp !== undefined,
	id: "create.status-matches-document",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const exchange = createExchange(ctx)
		if (exchange === undefined) return
		if (createOp.documentedStatuses.includes(exchange.status)) return
		const success = createOp.documentedStatuses.filter((s) => s < 300)
		if (success.length === 0) return
		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"create returns a success status the document does not declare",
			`${createOp.operationId} returned ${exchange.status}; the document declares ` +
				`${success.join(", ")}. Either the handler or the document is wrong, and clients ` +
				"generated from the spec will not recognise the response.",
			[exchange],
		)
	},
}

/**
 * The successful create exchange for this entity, matched on the fully-resolved path.
 *
 * Prefix matching is not enough: two entities can share a prefix up to their first path
 * parameter (`/v1/projects/{project_id}/tables` and `.../tables/{table_id}/rows` both truncate
 * to `/v1/projects/`), which silently pairs one entity's response with another's schema.
 */
function createExchange(ctx: CheckContext): Exchange | undefined {
	const createOp = ctx.createOp
	if (createOp === undefined) return undefined
	let resolved: string
	try {
		resolved = fillPath(createOp.path, ctx.scope)
	} catch {
		return undefined
	}
	return ctx.client.transcript.find(
		(e) => e.method === "POST" && e.status < 300 && new URL(e.url).pathname === resolved,
	)
}

const deleteMissingIs404: Check = {
	applicable: (ctx) => ctx.deleteOp !== undefined,
	id: "delete.absent-record-returns-404",
	async run(ctx) {
		if (ctx.deleteOp === undefined) return
		const params = { ...ctx.scope, ...itemParamFor(ctx, "oat-nonexistent-id-000") }
		const exchange = await ctx.client.request("DELETE", fillPath(ctx.deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (exchange.status === 404 || exchange.status === 410 || exchange.status === 400) return
		if (exchange.status >= 300) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"deleting a nonexistent record reports success",
			`DELETE of an id that was never created returned ${exchange.status}. Callers cannot ` +
				"distinguish a real deletion from a no-op, which hides broken client state.",
			[exchange],
		)
	},
}

const softDeleteHidden: Check = {
	applicable: (ctx) => ctx.deleteOp !== undefined && ctx.softDelete !== null && ctx.records.length > 1,
	id: "softdelete.absent-from-default-list",
	async run(ctx) {
		const target = ctx.records.at(-1)
		if (target === undefined || ctx.deleteOp === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const deleted = await ctx.client.request("DELETE", fillPath(ctx.deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (deleted.status >= 300) return

		const after = await list(ctx, { limit: ctx.query?.maxLimit ?? 100 })
		if (!ids(after.items, ctx.identity).includes(id)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"soft-deleted record still appears in the default listing",
			`${ctx.entityName} ${id} was deleted (tombstoned via "${ctx.softDelete}") but the default ` +
				"list still returns it. Tombstones must be excluded unless explicitly requested.",
			[deleted, after.exchange],
		)
	},
}

const crossTenantItemRead: Check = {
	applicable: (ctx) => ctx.altAuth !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
	id: "tenant.item-not-readable-cross-tenant",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.readOp === undefined || ctx.altAuth === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }
		const exchange = await ctx.client.get(fillPath(ctx.readOp.path, params), {
			headers: ctx.altAuth(),
		})
		if (exchange.status === 403 || exchange.status === 404) return
		if (exchange.status >= 400) return
		ctx.findings.security(
			this.id,
			ctx.entityName,
			"a record is readable by a principal in another tenant",
			`${ctx.entityName} ${id} belongs to one tenant but a principal from another read it ` +
				`successfully (${exchange.status}).`,
			[exchange],
		)
	},
}

const crossTenantFilterBypass: Check = {
	applicable: (ctx) =>
		ctx.altAuth !== undefined &&
		ctx.altScope !== undefined &&
		ctx.listOp.queryParamNames.includes("filter") &&
		ctx.records.length > 0,
	id: "tenant.filter-does-not-bypass-scope",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.altAuth === undefined || ctx.altScope === undefined) return
		if (!(ctx.query?.filterable.includes(ctx.identity) ?? false)) return
		const id = String(target[ctx.identity])

		const result = await list(
			ctx,
			{ filter: `${ctx.identity}.eq.${id}`, limit: 100 },
			ctx.altAuth,
			ctx.altScope,
		)
		if (result.exchange.status >= 400) return
		if (!ids(result.items, ctx.identity).includes(id)) return
		ctx.findings.security(
			this.id,
			ctx.entityName,
			"a filter reaches records outside the caller's tenant",
			`a principal in another tenant filtered on ${ctx.identity}.eq.${id} and received the ` +
				"record. The tenant predicate is applied to the base listing but not re-applied to " +
				"filter matches, so any caller who can guess an id can read it.",
			[result.exchange],
		)
	},
}

const malformedFilterNot5xx: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("filter"),
	id: "error.malformed-filter-not-5xx",
	async run(ctx) {
		const result = await list(ctx, { filter: "((((", limit: 10 })
		if (result.exchange.status < 500) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"malformed filter input produces a server error",
			`a syntactically invalid filter returned ${result.exchange.status}. Bad client input must ` +
				"be rejected with a 4xx; a 5xx means the parser is throwing rather than validating.",
			[result.exchange],
		)
	},
}

const limitBoundsPageSize: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("limit") && ctx.records.length > 2,
	dependsOn: ["list.read-after-write"],
	id: "pagination.limit-bounds-page-size",
	async run(ctx) {
		const result = await list(ctx, { limit: 2 })
		if (result.exchange.status >= 400) return
		if (result.items.length <= 2) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"limit does not bound the number of records returned",
			`limit=2 returned ${result.items.length} records. A page size the backend accepts and ` +
				"ignores means callers cannot bound response size, and every paging loop is wrong.",
			[result.exchange],
		)
	},
}

const limitRespectsMax: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("limit") &&
		ctx.query?.maxLimit !== undefined &&
		/* Unless the collection holds more records than the cap, an uncapped backend and a
		 * capped one return the same thing and the check would prove nothing. */
		ctx.records.length > (ctx.query.maxLimit ?? Number.POSITIVE_INFINITY),
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.limit-respects-documented-max",
	async run(ctx) {
		const max = ctx.query?.maxLimit
		if (max === undefined) return
		const result = await list(ctx, { limit: max + 50 })
		if (result.exchange.status >= 400) return
		if (result.items.length <= max) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"page size exceeds the documented maximum",
			`limit=${max + 50} returned ${result.items.length} records; the document caps limit at ` +
				`${max}. Either the cap is not enforced or the document overstates it.`,
			[result.exchange],
		)
	},
}

const hasMoreIsAccurate: Check = {
	applicable: (ctx) => ctx.listOp.queryParamNames.includes("page") && ctx.records.length > 2,
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.has-more-is-accurate",
	async run(ctx) {
		const first = await list(ctx, { limit: 1, page: 1 })
		if (first.exchange.status >= 400 || first.items.length === 0) return
		const flag = first.envelope.hasMore
		if (typeof flag !== "boolean") return

		const second = await list(ctx, { limit: 1, page: 2 })
		const moreExist = second.items.length > 0
		if (flag === moreExist) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			flag
				? "hasMore claims further pages exist when none do"
				: "hasMore claims no further pages while the next page returns records",
			`page 1 at limit=1 reported hasMore=${flag}, but page 2 returned ` +
				`${second.items.length} record(s). Callers that trust the flag will ` +
				(flag ? "request an empty page" : "silently stop after the first page"),
			[first.exchange, second.exchange],
		)
	},
}

const orderChangesResult: Check = {
	applicable: (ctx) => (ctx.query?.sortable.length ?? 0) > 0 && ctx.records.length > 2,
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "sort.order-is-applied",
	async run(ctx) {
		const field = ctx.query?.sortable.find((f) => f !== ctx.identity) ?? ctx.query?.sortable[0]
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const ascending = await list(ctx, { limit, order: `${field}.asc` })
		if (ascending.exchange.status >= 400 || ascending.items.length < 2) return

		const values = ascending.items.map((item) => item[field])
		if (values.some((value) => value === undefined)) return
		const sorted = [...values].sort(compareValues)
		if (JSON.stringify(values) === JSON.stringify(sorted)) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"order is accepted but the result is not sorted",
			`order=${field}.asc returned records whose "${field}" values are not ascending: ` +
				`${values.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}. A sort parameter the ` +
				"backend ignores silently gives every caller arbitrary ordering.",
			[ascending.exchange],
		)
	},
}

function compareValues(a: unknown, b: unknown): number {
	if (a === null || a === undefined) return -1
	if (b === null || b === undefined) return 1
	if (typeof a === "number" && typeof b === "number") return a - b
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

const searchNarrowsResult: Check = {
	applicable: (ctx) =>
		ctx.listOp.queryParamNames.includes("q") &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: ["list.read-after-write"],
	id: "search.q-narrows-result",
	async run(ctx) {
		const field = ctx.query?.searchable[0]
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const all = await list(ctx, { limit })
		if (all.items.length < 2) return

		/* A token no record can contain: a correct search returns nothing. */
		const result = await list(ctx, { limit, q: "zzqqxx-oat-no-match-token" })
		if (result.exchange.status >= 400) return
		if (result.items.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"free-text search returns records that cannot match",
			`q= a token no record contains returned ${result.items.length} of ${all.items.length} ` +
				"records, so the search term is being ignored rather than applied.",
			[all.exchange, result.exchange],
		)
	},
}

const createPersistsFields: Check = {
	applicable: (ctx) => ctx.createOp !== undefined && ctx.records.length > 0,
	dependsOn: ["list.read-after-write"],
	id: "create.persists-submitted-fields",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const sent = createExchange(ctx)
		if (sent === undefined || sent.requestBody === undefined) return
		const request = sent.requestBody as Record_
		const response = (sent.responseBody ?? {}) as Record_

		const dropped = Object.entries(request).filter(([key, value]) => {
			if (value === null || value === undefined) return false
			if (!Object.hasOwn(response, key)) return true
			return JSON.stringify(response[key]) !== JSON.stringify(value)
		})
		if (dropped.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"create silently discards submitted fields",
			`the create response does not carry back ${dropped.length} submitted field(s): ` +
				dropped
					.slice(0, 4)
					.map(([key, value]) => `${key} sent ${JSON.stringify(value)}, got ${JSON.stringify(response[key])}`)
					.join("; ") +
				". A write that reports success and drops data is worse than one that fails.",
			[sent],
		)
	},
}

const enumValidated: Check = {
	applicable: (ctx) => ctx.createOp !== undefined,
	id: "validation.enum-enforced",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) return
		const target = findConstrained(schema, (s) => Array.isArray(s.enum) && s.enum.length > 0)
		if (target === null) return

		const body = { ...validBody(ctx, schema), [target.name]: "oat-not-a-member" }
		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			body,
			headers: ctx.auth(),
		})
		if (exchange.status >= 400) return

		const declared = (target.schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a value outside the declared enum was accepted",
			`"${target.name}" declares [${declared}] but the backend accepted "oat-not-a-member" ` +
				`with ${exchange.status}. Clients generated from this document will assume the field ` +
				"only ever holds a declared member.",
			[exchange],
		)
	},
}

const maxLengthValidated: Check = {
	applicable: (ctx) => ctx.createOp !== undefined,
	id: "validation.max-length-enforced",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) return
		const target = findConstrained(
			schema,
			(s) => typeof s.maxLength === "number" && (s.maxLength as number) < 4096,
		)
		if (target === null) return
		const max = target.schema.maxLength as number

		const body = { ...validBody(ctx, schema), [target.name]: "x".repeat(max + 25) }
		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			body,
			headers: ctx.auth(),
		})
		if (exchange.status >= 400) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a string longer than the declared maxLength was accepted",
			`"${target.name}" declares maxLength ${max} but a ${max + 25}-character value was stored ` +
				`(${exchange.status}). The constraint exists in the document only.`,
			[exchange],
		)
	},
}

const requiredValidated: Check = {
	applicable: (ctx) => ctx.createOp !== undefined,
	id: "validation.required-enforced",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) return
		const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
		const field = required[0]
		if (field === undefined) return

		const { [field]: _omitted, ...body } = validBody(ctx, schema)
		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			body,
			headers: ctx.auth(),
		})
		if (exchange.status >= 400) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"create succeeded without a required field",
			`"${field}" is listed in the schema's required array, but omitting it returned ` +
				`${exchange.status}. Either the handler does not validate it or the document ` +
				"overstates the requirement.",
			[exchange],
		)
	},
}

const contentTypeEnforced: Check = {
	applicable: (ctx) => ctx.createOp !== undefined && ctx.createOp.documentedStatuses.includes(415),
	id: "validation.content-type-enforced",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return
		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) return

		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			body: validBody(ctx, schema),
			contentType: "text/plain",
			headers: ctx.auth(),
		})
		if (exchange.status === 415 || exchange.status >= 400) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a non-JSON content type was accepted on a JSON endpoint",
			`the operation documents 415 and declares only a JSON request body, but a request sent ` +
				`as text/plain was processed (${exchange.status}). Content negotiation is documented ` +
				"but not implemented.",
			[exchange],
		)
	},
}

const errorSchemaHonoured: Check = {
	applicable: (ctx) => ctx.validator !== undefined && ctx.readOp !== undefined,
	id: "schema.error-response-matches-document",
	async run(ctx) {
		const readOp = ctx.readOp
		const validator = ctx.validator
		if (readOp === undefined || validator === undefined) return
		const raw = ctx.model.rawOperations.get(readOp.operationId)
		if (raw === undefined) return

		const params = { ...ctx.scope, ...itemParamFor(ctx, "oat-definitely-missing-id") }
		const exchange = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		if (exchange.status < 400) return
		if (!validator.documents(raw, exchange.status)) return

		const result = validator.validate(readOp.operationId, raw, exchange.status, exchange.responseBody)
		if (result.ok) return

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			`${exchange.status} error body does not match its documented schema`,
			`${readOp.operationId} returned ${exchange.status} with a body that fails the schema the ` +
				`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
				"from the spec will not understand this response.",
			[exchange],
		)
	},
}

const successSchemaHonoured: Check = {
	applicable: (ctx) => ctx.validator !== undefined && ctx.createOp !== undefined,
	id: "schema.success-response-matches-document",
	async run(ctx) {
		const createOp = ctx.createOp
		const validator = ctx.validator
		if (createOp === undefined || validator === undefined) return
		const raw = ctx.model.rawOperations.get(createOp.operationId)
		if (raw === undefined) return

		const exchange = createExchange(ctx)
		if (exchange === undefined) return
		if (!validator.documents(raw, exchange.status)) return

		const result = validator.validate(
			createOp.operationId,
			raw,
			exchange.status,
			exchange.responseBody,
		)
		if (result.ok) return

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"success response does not match its documented schema",
			`${createOp.operationId} returned ${exchange.status} with a body that fails the declared ` +
				`schema: ${result.errors.join("; ")}. Either the handler returns more than it promises ` +
				"or the document is out of date — both break generated clients.",
			[exchange],
		)
	},
}

/** Builds a body that should be accepted, for use as the base of a negative probe. */
function validBody(ctx: CheckContext, schema: Record<string, unknown>): Record<string, unknown> {
	const [member] = buildCohort(schema, ctx.seed, ["baseline"])
	return member?.body ?? {}
}

function requestSchemaOf(
	ctx: CheckContext,
	op: OperationModel,
): Record<string, unknown> | null {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const content = raw?.requestBody?.content
	if (content === undefined) return null
	for (const [mediaType, media] of Object.entries(content)) {
		if (mediaType.includes("json") && media.schema !== undefined) return media.schema
	}
	return null
}

interface ConstrainedField {
	name: string
	schema: Record<string, unknown>
}

function findConstrained(
	schema: Record<string, unknown>,
	predicate: (s: Record<string, unknown>) => boolean,
): ConstrainedField | null {
	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	for (const [name, raw] of Object.entries(props as Record<string, Record<string, unknown>>)) {
		if (raw === null || typeof raw !== "object") continue
		if (raw.readOnly === true) continue
		if (predicate(raw)) return { name, schema: raw }
		const union = raw.oneOf ?? raw.anyOf
		if (Array.isArray(union)) {
			const branch = union.find(
				(candidate) =>
					candidate !== null &&
					typeof candidate === "object" &&
					predicate(candidate as Record<string, unknown>),
			)
			if (branch !== undefined) return { name, schema: branch as Record<string, unknown> }
		}
	}
	return null
}

/**
 * Order matters. Cascade suppression consults findings already reported for this entity, so a
 * check must run after everything it depends on — primitives first, then the properties built
 * on top of them. Otherwise a broken primitive is reported once as itself and again as every
 * downstream consequence.
 */
export const CHECKS: readonly Check[] = [
	/* foundations — is the write visible, and do the paging primitives work at all */
	readAfterWrite,
	createStatusMatchesSpec,
	successSchemaHonoured,
	errorSchemaHonoured,
	limitBoundsPageSize,
	limitRespectsMax,
	hasMoreIsAccurate,

	/* query semantics */
	unknownFilterRejected,
	malformedFilterNot5xx,
	equalityFilterSelectsOne,
	zeroMatchFilter,
	negationPartitions,
	likeEscaping,
	orderChangesResult,
	sortReverseSymmetry,
	searchNarrowsResult,
	selectProjection,
	countMatchesWalk,

	/* pagination properties, which assume the primitives above hold */
	pageWalkCoversSet,
	cursorAgreesWithPage,

	/* write semantics */
	createPersistsFields,
	patchMinimality,
	immutableRejected,
	deleteMissingIs404,
	softDeleteHidden,

	/* input validation */
	enumValidated,
	maxLengthValidated,
	requiredValidated,
	contentTypeEnforced,

	/* isolation */
	crossTenantItemRead,
	crossTenantFilterBypass,
]
