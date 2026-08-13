/**
 * The check registry.
 *
 * Each check asserts one property that must hold for any correct implementation. They need no
 * ground truth — they compare the API against itself, through independent projections, or against
 * the oracle of what oat just wrote. Check ids are stable: the conformance suite asserts on them.
 */

import { filterTerm, selectTerm, sortTerm } from "../spec/conventions.ts"
import type { QueryCapability } from "../spec/extensions.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import { driveAsync } from "./async.ts"
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
	/** Operations on this entity declared async via `x-async`. */
	asyncOps: OperationModel[]
	/** Operations on this entity that declare `x-effects`. */
	effectOps: OperationModel[]
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
	/**
	 * What this check needs in order to run at all, in the reader's terms.
	 *
	 * Reported when `applicable` returns false. Skipping silently would leave someone on an API
	 * shaped differently from the fixture believing a quiet run meant a clean one, when in truth
	 * half the suite never fired.
	 */
	needs?: string
	/**
	 * Whether the check changes server state. Mutating checks run alone and in order; read-only
	 * checks batch together. Two writers racing on the same cohort would make each other's
	 * observations wrong, and the resulting finding would describe the interference rather than
	 * the backend.
	 */
	mutates?: boolean
	run: (ctx: CheckContext) => Promise<void>
}

/* ------------------------------------------------------------------- helpers */

/** The list endpoint's derived conventions — parameter roles and envelope spellings. */
function conv(ctx: CheckContext) {
	return ctx.listOp.conventions
}

/**
 * Builds a query using whatever this endpoint actually calls each role.
 *
 * `{ limit: 2, page: 1 }` becomes `?per_page=2&page_number=1` where that is how the document
 * spells them, so a check written once works against an API that shares no parameter names with
 * the fixture.
 */
function q(
	ctx: CheckContext,
	roles: {
		limit?: number | undefined
		page?: number | undefined
		cursor?: string | undefined
		order?: string | undefined
		search?: string | undefined
		filter?: string | undefined
	},
): Record<string, string | number | undefined> {
	const c = conv(ctx)
	const out: Record<string, string | number | undefined> = {}
	if (roles.limit !== undefined && c.limit !== undefined) out[c.limit] = roles.limit
	if (roles.page !== undefined && c.page !== undefined) out[c.page] = roles.page
	else if (roles.page !== undefined && c.offset !== undefined) {
		/*
		 * Offset paging expressed from a page number.
		 *
		 * Some APIs count pages, some count rows skipped; the *property* every paging check is
		 * asserting — that walking forward covers the set without gaps or repeats — is identical
		 * either way. Translating here means a check says "page 3" once and works against both.
		 * Without it a page-numbered request against an offset API silently omits the parameter
		 * and every page comes back as the first one, which reads as a backend that ignores
		 * pagination rather than a tool that cannot express it.
		 */
		/* A page size must be assumed when the caller did not state one; 20 is the common default
		 * and any consistent value keeps the walk's arithmetic self-consistent, which is what the
		 * property depends on. */
		const size = roles.limit ?? 20
		out[c.offset] = Math.max(roles.page - 1, 0) * size
	}
	if (roles.cursor !== undefined && c.cursor !== undefined) out[c.cursor] = roles.cursor
	if (roles.order !== undefined && c.order !== undefined) out[c.order] = roles.order
	if (roles.search !== undefined && c.search !== undefined) out[c.search] = roles.search
	if (roles.filter !== undefined && c.filter !== undefined) out[c.filter] = roles.filter
	return out
}

/**
 * Whether an equality predicate can be expressed against this endpoint at all.
 *
 * Not "is there a `filter` parameter": the most common shape in the wild has no such parameter and
 * instead accepts one query parameter per field — `?status=active`. Gating on the parameter meant
 * every filter check silently skipped itself against those APIs, which is the same failure as a
 * check that cannot express a request being mistaken for a backend that ignores one.
 *
 * Checks needing an operator the grammar cannot write — a negation under equality-only filtering —
 * still stand down individually, because `filterTerm` returns null for them and there is genuinely
 * no request to send.
 */
function filterable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	if (c.filter !== undefined) return true
	/* Equality-per-field needs a field to attach the predicate to, and the document has to say
	 * which fields are filterable — otherwise oat would be guessing at parameter names. */
	return c.grammar === "equality" && (ctx.query?.filterable.length ?? 0) > 0
}

/**
 * Whether the endpoint can be walked forward at all, however it counts.
 *
 * Page numbers and row offsets are two ways of expressing the same request, and every paging
 * property — that walking forward covers the set without gaps or repeats, that a more-pages
 * signal is honest — holds identically under both. Gating those checks on a *page* parameter
 * meant an offset-paged API silently skipped them, which reads exactly like a clean result.
 */
function pageable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	return c.page !== undefined || c.offset !== undefined
}

/**
 * Reads a pagination fact by whatever the document calls it — and from wherever it lives.
 *
 * Most APIs put these in the body. Some put them nowhere at all and publish a `Link` header
 * instead, in which case "are there more pages" is answered by the presence of `rel="next"`
 * rather than by a boolean field. Both are answers to the same question, so both are resolved
 * here and every check that asks stays unaware of the difference.
 */
function envelopeValue(ctx: CheckContext, result: ListResult, role: "total" | "hasMore" | "nextCursor"): unknown {
	const key = conv(ctx).envelope[role]
	if (key !== undefined) return result.envelope[key]

	const c = conv(ctx)
	if (c.linkHeader === undefined) return undefined
	/* The document declares a Link header, so its *absence* on a given response is meaningful:
	 * no `rel="next"` means there is no next page. Treating a missing header as "unknown" would
	 * let a backend that simply stops emitting links look untestable rather than wrong. */
	const link = linkRelations(result.exchange)
	if (role === "hasMore") return link?.has("next") ?? false
	if (role === "nextCursor") return link?.get("next") ?? null
	return undefined
}

/** Parses RFC 8288 `Link` into rel → URL, or null when the response carries no such header. */
function linkRelations(exchange: Exchange): Map<string, string> | null {
	const header = exchange.responseHeaders?.link ?? exchange.responseHeaders?.Link
	if (typeof header !== "string" || header === "") return null
	const relations = new Map<string, string>()
	for (const part of header.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim())
		if (match?.[1] !== undefined && match[2] !== undefined) relations.set(match[2].trim(), match[1])
	}
	return relations.size === 0 ? null : relations
}

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

/**
 * How many pages a walk will traverse.
 *
 * Walking a whole collection is O(n) strictly sequential requests, so against a large existing
 * dataset it dominates the entire run — and buys nothing. Pagination defects manifest at the
 * *first* page boundary: a missing tiebreak, an off-by-one offset, a drifting cursor all show up
 * within the first few pages or not at all. Bounding the walk makes runtime independent of how
 * much data the system under test happens to be holding.
 */
const MAX_WALK_PAGES = 6

interface Walk {
	ids: string[]
	/** True when the walk stopped at the page cap rather than at the end of the collection. */
	truncated: boolean
}

/**
 * Collects a whole result set by paging, for checks that reason about set algebra.
 *
 * A single page is only the complete set when the collection happens to be smaller than one page,
 * which is true of a fixture and false of most real APIs. Bailing out in that case left the
 * strongest properties — partitioning, counting, zero-match — untested on exactly the collections
 * where they matter, so the set is gathered across pages instead.
 *
 * Stops on a short page rather than on `hasMore`, because a backend whose more-pages flag is
 * wrong is one of the things these checks exist to catch.
 */
async function collectSet(
	ctx: CheckContext,
	pageSize: number,
	extra: Record<string, string> = {},
	maxPages = MAX_WALK_PAGES,
	order?: string,
): Promise<{ items: Record_[]; complete: boolean; last: ListResult } | null> {
	const items: Record_[] = []
	let last: ListResult | null = null
	for (let page = 1; page <= maxPages; page++) {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize, order, page }), ...extra })
		last = result
		if (result.exchange.status >= 400) return null
		items.push(...result.items)
		if (result.items.length < pageSize) return { complete: true, items, last: result }
	}
	return last === null ? null : { complete: false, items, last }
}

/** Walks pages in order, returning ids as encountered (duplicates preserved). */
async function walkPages(
	ctx: CheckContext,
	pageSize: number,
	order?: string,
	maxPages = MAX_WALK_PAGES,
): Promise<Walk> {
	const seen: string[] = []
	for (let page = 1; page <= maxPages; page++) {
		const result = await list(ctx, q(ctx, { limit: pageSize, order, page }))
		seen.push(...ids(result.items, ctx.identity))
		const hasMore = envelopeValue(ctx, result, "hasMore")
		if (hasMore !== true || result.items.length === 0) return { ids: seen, truncated: false }
	}
	return { ids: seen, truncated: true }
}

async function walkCursor(
	ctx: CheckContext,
	pageSize: number,
	order?: string,
	maxPages = MAX_WALK_PAGES,
): Promise<Walk> {
	const seen: string[] = []
	let cursor: string | undefined
	for (let hop = 0; hop < maxPages; hop++) {
		const result = await list(ctx, q(ctx, { cursor, limit: pageSize, order }))
		seen.push(...ids(result.items, ctx.identity))
		const next = envelopeValue(ctx, result, "nextCursor")
		if (typeof next !== "string" || next === "" || result.items.length === 0) {
			return { ids: seen, truncated: false }
		}
		cursor = next
	}
	return { ids: seen, truncated: true }
}

/**
 * Whether a result is the complete set rather than a truncated page.
 *
 * Does not consult `hasMore`, and that is the whole point: checks reasoning about set algebra
 * have to stay correct on a backend whose more-pages flag is itself wrong, or one defect
 * masquerades as another. This previously did read the flag, which meant a backend reporting
 * `hasMore` from a miscounted total silently disabled every downstream set check — they returned
 * without a word and the report looked clean.
 *
 * A page holding fewer records than it asked for cannot have been truncated. That is decidable
 * from the response alone, and it is enough.
 */
function isComplete(_ctx: CheckContext, result: ListResult, requestedLimit: number): boolean {
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
	mutates: true,
	id: "list.read-after-write",
	needs: "a create operation and at least one seeded record",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const pageSize = ctx.query?.maxLimit ?? 100
		const full = await list(ctx, q(ctx, { limit: pageSize }))
		if (full.items.some((item) => String(item[ctx.identity]) === id)) return

		/* Absent from the first page is not absent from the collection — a cohort larger than
		 * maxLimit spans several pages. Confirm across the whole walk before calling it missing,
		 * or every capped collection reports a phantom lost write. */
		if (envelopeValue(ctx, full, "hasMore") === true && (await walkPages(ctx, pageSize)).ids.includes(id)) return

		/* A record that appears on a repeat request was never lost — it was unreachable for one
		 * query. That is an ordering defect, which the pagination checks diagnose precisely;
		 * reporting it here as a lost write would name the wrong cause. This check is about
		 * records the list *never* shows. */
		for (let attempt = 0; attempt < 2; attempt++) {
			const retry = await list(ctx, q(ctx, { limit: pageSize }))
			if (retry.items.some((item) => String(item[ctx.identity]) === id)) return
			if (envelopeValue(ctx, retry, "hasMore") === true && (await walkPages(ctx, pageSize)).ids.includes(id)) return
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
	/*
	 * Deliberately narrower than `filterable`: this asserts that a *filter expression* naming a
	 * field the document does not declare is rejected rather than dropped.
	 *
	 * Under one-parameter-per-field equality there is no expression language, so an unrecognised
	 * parameter is just an unrecognised query parameter — and ignoring those is conventional,
	 * widely relied upon, and not a defect. Reporting it as one would fire against a large share
	 * of real APIs, which is how a tool earns a reputation for crying wolf.
	 */
	applicable: (ctx) => conv(ctx).filter !== undefined,
	id: "filter.unknown-field-rejected",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	async run(ctx) {
		const baseline = await list(ctx, q(ctx, { limit: 100 }))
		const unknownField = filterTerm(conv(ctx), "oat_no_such_field_xyz", "eq", 1)
		if (unknownField === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...unknownField })

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
		filterable(ctx) &&
		ctx.records.length > 0 &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: ["list.read-after-write"],
	id: "filter.equality-selects-exactly-one",
	needs: "a `filter` parameter that accepts the identity field",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const term = filterTerm(conv(ctx), ctx.identity, "eq", id)
		if (term === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...term })
		/* A rejected filter is not a wrong answer. If the backend says this field is not
		 * filterable, that is a capability statement — the gap belongs to x-query, which is
		 * already reported, not here. Reading a 4xx as "returned zero records" invents a defect. */
		if (result.exchange.status >= 400) return
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
		filterable(ctx) &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: ["list.read-after-write"],
	id: "filter.zero-match-returns-none",
	needs: "a `filter` parameter that accepts the identity field",
	async run(ctx) {
		const term = filterTerm(conv(ctx), ctx.identity, "eq", "oat-nonexistent-value-000")
		if (term === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...term })
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
		filterable(ctx) &&
		ctx.records.length > 1 &&
		(ctx.query?.filterable.includes(ctx.identity) ?? false),
	dependsOn: [
		"list.read-after-write",
		/* Partitioning is asserted over field *values*. A backend that drops submitted fields
		 * leaves the cohort without the value the predicate is built from. */
		"create.persists-submitted-fields",
		/* The three sets are gathered across pages, so a walk that skips or repeats records makes
		 * the partition fail for a reason that has nothing to do with the predicate. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.negation-partitions-the-set",
	needs: "a `filter` parameter supporting eq and neq",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		/* Prefer a field with nulls in the cohort: partitioning on the identity can never expose
		 * three-valued-logic bugs, because an identity is never null. */
		const field = nullableField(ctx, ctx.query?.filterable ?? []) ?? ctx.identity
		const probe = ctx.records.map((r) => r[field]).find((v) => v !== null && v !== undefined)
		if (probe === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`every record in the cohort has a null "${field}", leaving no value to negate`,
			)
		}
		const value = String(probe)
		const limit = ctx.query?.maxLimit ?? 100
		const eqTerm = filterTerm(conv(ctx), field, "eq", value)
		const neqTerm = filterTerm(conv(ctx), field, "neq", value)
		/* Negation has no representation in an equality-only grammar, so this property simply
		 * cannot be expressed against such an API — better to stand down than to send something
		 * meaningless and read the answer as a defect. */
		if (eqTerm === null || neqTerm === null) return
		const all = await collectSet(ctx, limit)
		const matching = await collectSet(ctx, limit, eqTerm)
		const complement = await collectSet(ctx, limit, neqTerm)
		if (all === null || matching === null || complement === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the partition was rejected",
			)
		}
		/* Set algebra only holds over complete sets. A walk that hit the page cap has seen a
		 * prefix, and the union would legitimately miss whatever lies beyond it. */
		if (!all.complete || !matching.complete || !complement.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be compared "
					+ "against the whole set",
			)
		}

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
				[matching.last.exchange, complement.last.exchange],
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
				[all.last.exchange, matching.last.exchange, complement.last.exchange],
			)
		}
	},
}

const sortReverseSymmetry: Check = {
	applicable: (ctx) => (ctx.query?.sortable.length ?? 0) > 0 && ctx.records.length > 1,
	/* The property is asserted over a *nullable* sort key, because that is where null-ordering
	 * bugs live. A backend that drops submitted fields leaves that column uniformly null, and a
	 * sort over one repeated value is symmetric no matter how badly the backend sorts. */
	dependsOn: [
		"create.persists-submitted-fields",
		/* Reversing an order that is never applied returns the same page twice. Every sort
		 * property is untestable until ordering itself is known to work. */
		"sort.order-is-applied",
		/* Both directions are gathered across pages, so a walk that skips or repeats records
		 * changes the membership this check compares — for reasons that are not about sorting. */
		"pagination.page-walk-covers-set",
	],
	id: "sort.reverse-symmetry",
	needs: "an `order` parameter supporting asc and desc",
	async run(ctx) {
		/* A nullable sort key exercises null ordering, where the interesting bugs live. */
		const field =
			nullableField(ctx, ctx.query?.sortable ?? []) ??
			ctx.query?.sortable.find((f) => f !== ctx.identity) ??
			ctx.query?.sortable[0]
		if (field === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no sortable field is available to order by",
			)
		}
		const limit = ctx.query?.maxLimit ?? 100
		/* Gathered across pages: a collection larger than one page would otherwise leave this
		 * property — that a reversal reorders a set without changing its membership — untested on
		 * exactly the collections where sorting matters most. */
		const ascending = await collectSet(ctx, limit, {}, MAX_WALK_PAGES, sortTerm(conv(ctx), field, "asc"))
		const descending = await collectSet(ctx, limit, {}, MAX_WALK_PAGES, sortTerm(conv(ctx), field, "desc"))
		if (ascending === null || descending === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`ordering by "${field}" was rejected in one direction, so the two cannot be compared`,
			)
		}

		/* Only comparable when a single page holds the whole collection. Otherwise asc and desc
		 * return opposite *windows* of it — legitimately different sets, and comparing them would
		 * report every capped collection as broken. */
		if (!ascending.complete || !descending.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two directions return "
					+ "different windows of it rather than the same set reversed",
			)
		}

		const forward = ids(ascending.items, ctx.identity)
		const backward = ids(descending.items, ctx.identity)
		if (forward.length !== backward.length) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"ascending and descending sorts return different numbers of records",
				`order=${field}.asc returned ${forward.length}, order=${field}.desc returned ${backward.length}`,
				[ascending.last.exchange, descending.last.exchange],
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
				[ascending.last.exchange, descending.last.exchange],
			)
		}
	},
}

const pageWalkCoversSet: Check = {
	applicable: (ctx) => pageable(ctx) && ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"pagination.limit-bounds-page-size",
		"pagination.has-more-is-accurate",
		/* A page walk is only sound over a total order. Where the requested order is discarded,
		 * the pages are windows onto an arbitrary sequence, and any drift they show is the
		 * missing sort rather than a pagination defect. */
		"sort.order-is-applied",
	],
	id: "pagination.page-walk-covers-set",
	needs: "a way to page forward — a page number or a row offset — and at least three records",
	async run(ctx) {
		const limit = ctx.query?.maxLimit ?? 100
		/* Walk under a low-cardinality sort. Distinct keys admit exactly one valid order, so an
		 * unstable sort is indistinguishable from a correct one until values tie. */
		const order = tiedSortField(ctx)
		const orderParam = order === null ? undefined : sortTerm(conv(ctx), order, "asc")
		const single = await list(ctx, q(ctx, { limit, order: orderParam }))
		const walk = await walkPages(ctx, 2, orderParam)
		const walked = walk.ids
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
		/* A capped walk saw only a prefix of the collection, so "missing" would just mean "beyond
		 * the cap". Duplicates above are still meaningful; absence is not. */
		const missing = walk.truncated ? [] : expected.filter((id) => !walked.includes(id))
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
		const second = (await walkPages(ctx, 2, orderParam)).ids
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
	applicable: (ctx) => conv(ctx).cursor !== undefined && pageable(ctx) && ctx.records.length > 2,
	dependsOn: [
		"pagination.page-walk-covers-set",
		/* Sorting by a field whose value never persisted is degenerate, so a pagination
		 * disagreement there describes a consequence rather than a pagination defect. */
		"create.persists-submitted-fields",
		/* Both walks are taken at a requested page size. If the backend serves a different size
		 * than asked for, the two walks step differently and disagree for that reason alone. */
		"pagination.limit-respects-documented-max",
	],
	id: "pagination.cursor-agrees-with-page",
	needs: "both `cursor` and `page` parameters",
	async run(ctx) {
		/* Walk under an explicit text sort. Cursor pagination is almost always used with one, and
		 * a boundary resolved under a different collation than the listing can only diverge when
		 * the ordering key is text. */
		const sortField =
			ctx.query?.sortable.find((f) => {
				if (f === ctx.identity) return false
				return ctx.records.some((r) => typeof r[f] === "string" && r[f] !== "")
			}) ?? undefined
		const order = sortField === undefined ? undefined : sortTerm(conv(ctx), sortField, "asc")

		const pageWalk = await walkPages(ctx, 2, order)
		const cursorWalk = await walkCursor(ctx, 2, order)
		const byPage = pageWalk.ids
		const byCursor = cursorWalk.ids

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

		/* Two capped walks cover different prefixes when either was truncated, so only the
		 * duplicate check above is sound; set equality is not. */
		if (pageWalk.truncated || cursorWalk.truncated) return

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

/**
 * The reported total must be consistent with the page it accompanies.
 *
 * A count that reads zero beside a non-empty payload is not a rounding difference — it is a
 * separate query answering a different question, and every UI that renders "N results" from it
 * shows a number contradicted by the rows directly beneath.
 */
const countIsConsistentWithPage: Check = {
	applicable: (ctx) => ctx.records.length > 0,
	dependsOn: ["list.read-after-write"],
	id: "count.consistent-with-returned-page",
	needs: "a total-count field in the list envelope",
	async run(ctx) {
		const result = await list(ctx, q(ctx, { limit: ctx.query?.maxLimit ?? 100 }))
		if (result.exchange.status >= 400) return
		const reported = envelopeValue(ctx, result, "total")
		if (typeof reported !== "number") return
		const returned = result.items.length
		if (returned === 0) return
		if (reported >= returned) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"reported count is smaller than the number of records returned",
			`the response carries count=${reported} while returning ${returned} record(s) in the same ` +
				`body${envelopeValue(ctx, result, "hasMore") === true ? " and hasMore=true" : ""}. The total is being ` +
				"computed by a query that disagrees with the one producing the rows, so any caller " +
				"rendering a result count contradicts the list it is labelling.",
			[result.exchange],
		)
	},
}

const countMatchesWalk: Check = {
	applicable: (ctx) => ctx.records.length > 1 && filterable(ctx),
	/* Compares the reported total against the *filtered* set. Where the filter is ignored the two
	 * agree trivially — both describe the whole collection — so the count cannot be judged until
	 * filtering itself is known to work. */
	dependsOn: ["list.read-after-write", "filter.equality-selects-exactly-one"],
	id: "count.matches-filtered-set",
	needs: "a total-count field and a `filter` parameter",
	async run(ctx) {
		if (!(ctx.query?.filterable.includes(ctx.identity) ?? false)) return
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const countTerm = filterTerm(conv(ctx), ctx.identity, "eq", id)
		if (countTerm === null) return
		const filtered = await list(ctx, { ...q(ctx, { limit: 100 }), ...countTerm })
		if (filtered.exchange.status >= 400) return
		const reported = envelopeValue(ctx, filtered, "total")
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
	applicable: (ctx) => conv(ctx).select !== undefined && ctx.records.length > 0,
	id: "select.projection-honoured",
	needs: "a `select` sparse-fieldset parameter",
	async run(ctx) {
		const requested = [ctx.identity]
		const extra = ctx.query?.selectable.find((f) => f !== ctx.identity)
		if (extra !== undefined) requested.push(extra)

		/* Through the grammar, not the bare parameter: JSON:API carries the resource type in the
		 * parameter *name*, so `select=` never reaches a backend expecting `fields[table]=`. */
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		if (projection === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
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
	mutates: true,
	id: "patch.minimality",
	needs: "an update operation and an item route",
	async run(ctx) {
		const target = ctx.records.find((r) => Object.values(r).some((v) => typeof v === "string"))
		if (target === undefined || ctx.updateOp === undefined || ctx.readOp === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const before = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		if (before.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back returned ${before.status}, so no baseline could be established`,
			)
		}
		const original = (before.responseBody ?? {}) as Record_

		/* A control record, never written to, observed across the same window as the target.
		 * Real APIs expose server-driven fields — job progress, computed counts, expiry clocks —
		 * and repeated sampling cannot distinguish those from a write side effect once they
		 * settle. A field that moves on the control moved on its own. */
		const control = ctx.records.find((r) => String(r[ctx.identity]) !== id)
		const controlParams =
			control === undefined
				? undefined
				: { ...ctx.scope, ...itemParamFor(ctx, String(control[ctx.identity])) }
		const controlBefore =
			controlParams === undefined
				? undefined
				: await ctx.client.get(fillPath(ctx.readOp.path, controlParams), { headers: ctx.auth() })

		const settle = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		/*
		 * Fields that may move without this PATCH having moved them.
		 *
		 * Timestamps by name, and — more importantly — anything the document declares
		 * server-generated. A generated field is by definition not the caller's to set, so finding
		 * it changed proves nothing about whether PATCH behaved as PUT. Some are derived from
		 * *other* entities entirely (a row count on its parent table), and since entities are
		 * tested concurrently such a field can change mid-check for reasons that have nothing to
		 * do with this request. The control record catches drift the whole collection shares, but
		 * not drift confined to the one record under test.
		 */
		const drifting = new Set<string>([
			"updated_at",
			"modified_at",
			/*
			 * From both operations, not just the one being probed. A document commonly declares
			 * its server-owned fields on `create` — that is where they are conspicuous, being the
			 * fields a caller may not supply — and omits the same list on `update`. Reading only
			 * the update operation meant a field the document plainly called generated was still
			 * compared, and a progress counter advancing on its own read as a PATCH side effect.
			 */
			...(ctx.createOp?.generated ?? []),
			...(ctx.updateOp.generated ?? []),
		])
		if (settle.status < 300) {
			const second = (settle.responseBody ?? {}) as Record_
			for (const key of Object.keys(original)) {
				if (JSON.stringify(original[key]) !== JSON.stringify(second[key])) drifting.add(key)
			}
		}

		const field = pickWritableStringField(ctx, original)
		if (field === null) return

		const patched = await ctx.client.request("PATCH", fillPath(ctx.updateOp.path, params), {
			body: { [field]: "oat patched value" },
			headers: ctx.auth(),
		})
		if (patched.status >= 300) return

		const after = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		const current = (after.responseBody ?? {}) as Record_

		const baseline = (settle.status < 300 ? settle.responseBody : before.responseBody) as Record_
		let collateral = Object.keys(original).filter((key) => {
			if (key === field || drifting.has(key)) return false
			return JSON.stringify(baseline[key]) !== JSON.stringify(current[key])
		})
		if (collateral.length === 0) return

		/* Whatever also moved on the untouched control record was not caused by this PATCH. */
		if (controlParams !== undefined && controlBefore !== undefined && controlBefore.status < 300) {
			const controlAfter = await ctx.client.get(fillPath(ctx.readOp.path, controlParams), {
				headers: ctx.auth(),
			})
			if (controlAfter.status < 300) {
				const from = (controlBefore.responseBody ?? {}) as Record_
				const to = (controlAfter.responseBody ?? {}) as Record_
				collateral = collateral.filter(
					(key) => JSON.stringify(from[key]) === JSON.stringify(to[key]),
				)
			}
		}
		if (collateral.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"PATCH changed fields the request did not mention",
			`patching only "${field}" also changed ${collateral.length} other field(s): ` +
				collateral
					.slice(0, 5)
					.map((key) => `${key} ${JSON.stringify(baseline[key])} → ${JSON.stringify(current[key])}`)
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
	mutates: true,
	id: "patch.immutable-field-rejected",
	needs: "fields declared immutable via x-immutable",
	async run(ctx) {
		/*
		 * Deliberately not `records[0]`.
		 *
		 * An immutable field is very often the tenant or parent key, so a backend that accepts the
		 * write moves the record out of the scope every other check reads through — the record is
		 * then a 404 for everything that runs later. Claiming a record from the end of the cohort
		 * keeps the damage away from the one the write-path checks use, and it stays distinct from
		 * the tombstone check's target at the very end.
		 */
		const target = ctx.records.at(-2) ?? ctx.records[0]
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
	applicable: (ctx) => filterable(ctx) && ctx.records.length > 1,
	/* The tell is "the filtered result equals the whole listing". Where the listing is already
	 * wrong, that comparison is against a set the backend never served correctly. */
	dependsOn: ["list.read-after-write"],
	id: "filter.like-metacharacters-escaped",
	needs: "a `filter` parameter supporting a like operator",
	async run(ctx) {
		const field = firstFilterable(ctx, (name) => (ctx.query?.searchable ?? []).includes(name))
		if (field === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no field is both filterable and searchable, so no like probe can be built",
			)
		}
		const total = await list(ctx, q(ctx, { limit: 100 }))
		/* A literal `%` is not a wildcard in this grammar — `*` is. Matching everything means the
		 * value was interpolated into a LIKE pattern unescaped. */
		const likeTerm = filterTerm(conv(ctx), field, "like", "%")
		if (likeTerm === null) return
		const probe = await list(ctx, { ...q(ctx, { limit: 100 }), ...likeTerm })
		if (probe.exchange.status >= 400) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the like probe was rejected with ${probe.exchange.status}, so escaping was never exercised`,
			)
		}
		if (total.items.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the unfiltered listing returned nothing, leaving no baseline to compare the probe against",
			)
		}
		if (probe.items.length < total.items.length) return
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
	needs: "a create operation",
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
	mutates: true,
	id: "delete.absent-record-returns-404",
	needs: "a delete operation",
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
	mutates: true,
	/* The evidence for a tombstone leak is the record still being *in the listing*. On a backend
	 * whose listing already omits records it should contain, "absent" proves nothing. */
	dependsOn: ["list.read-after-write"],
	id: "softdelete.absent-from-default-list",
	needs: "a delete operation and x-soft-delete",
	async run(ctx) {
		const target = ctx.records.at(-1)
		if (target === undefined || ctx.deleteOp === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const deleted = await ctx.client.request("DELETE", fillPath(ctx.deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (deleted.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`DELETE returned ${deleted.status}, so no tombstone was created to look for`,
			)
		}

		const after = await list(ctx, q(ctx, { limit: ctx.query?.maxLimit ?? 100 }))
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

/**
 * A denial must not reveal whether the record exists.
 *
 * Refusing a cross-tenant read is correct. Refusing it with a *different status* than an id that
 * was never issued is an oracle: an attacker walks the identifier space and reads existence off
 * the status code, learning how many records another tenant holds and which ids are live — all
 * without ever being served a body. The access decision looks right in every log.
 *
 * The comparison is what makes this decidable without knowing the backend's policy. Whichever
 * status it picks is fine; picking two different ones is not.
 */
const denialDoesNotRevealExistence: Check = {
	applicable: (ctx) =>
		ctx.altAuth !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
	dependsOn: [
		/* If the record is readable across tenants at all, that is the finding — how the denial
		 * would have been phrased is beside the point. */
		"tenant.item-not-readable-cross-tenant",
	],
	id: "tenant.denial-does-not-reveal-existence",
	needs: "a second principal in a different tenant",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.readOp === undefined || ctx.altAuth === undefined) return
		const realId = String(target[ctx.identity])
		/* Shaped like a real identifier so the difference under test is existence, not format —
		 * a backend may legitimately reject a malformed id differently. */
		const absentId = `${realId}-oat-absent`

		const ask = async (id: string): Promise<Exchange> =>
			ctx.client.get(
				fillPath(ctx.readOp?.path ?? "", { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }),
				{ headers: ctx.altAuth?.() ?? {} },
			)

		const existing = await ask(realId)
		const absent = await ask(absentId)

		/* Only a denial pair is meaningful. A 2xx on the existing record is a cross-tenant read,
		 * which the check above owns and this one is suppressed by. */
		if (existing.status < 400 || absent.status < 400) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the two probes was not denied, so there is no pair of denials to compare",
			)
		}
		if (existing.status === absent.status) return

		ctx.findings.security(
			this.id,
			ctx.entityName,
			"the denial status reveals whether a record exists",
			`a record belonging to another tenant was refused with ${existing.status}, while an id `
				+ `that does not exist was refused with ${absent.status}. The difference is an oracle: `
				+ "anyone able to guess or enumerate identifiers can learn which ones are real without "
				+ "ever reading one. Both cases must answer identically — conventionally 404.",
			[existing, absent],
		)
	},
}

/**
 * Replaying a create with the same idempotency key must not create a second record.
 *
 * An API that publishes the header has made a promise, and it is a promise clients rely on to
 * make retries safe: a timeout, a proxy replay or a double-click all resend the same request. If
 * the key is accepted and ignored, every one of those silently duplicates whatever the record
 * represents — a charge, an order, a transfer. Nothing about a single request reveals this;
 * it only shows up when the request is actually replayed.
 *
 * Both halves are asserted, because either alone is satisfiable by a broken backend: the replay
 * must return the *original* record, and the collection must not have grown.
 */
const idempotentReplay: Check = {
	applicable: (ctx) => ctx.createOp?.idempotencyHeader != null,
	dependsOn: ["list.read-after-write", "create.persists-submitted-fields"],
	id: "idempotency.replay-does-not-duplicate",
	mutates: true,
	needs: "a create operation declaring an idempotency-key header",
	async run(ctx) {
		const createOp = ctx.createOp
		const header = createOp?.idempotencyHeader
		if (createOp === undefined || header == null) return

		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the create operation declares no JSON request body to replay",
			)
		}

		const body = validBody(ctx, schema)
		const key = `oat-idem-${ctx.seed}-${ctx.entityName}`
		const path = fillPath(createOp.path, ctx.scope)
		const headers = { ...ctx.auth(), [header]: key }

		const first = await ctx.client.request("POST", path, { body, headers })
		if (first.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the first create returned ${first.status}, so there was nothing to replay`,
			)
		}
		const second = await ctx.client.request("POST", path, { body, headers })
		if (second.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the replay returned ${second.status}; a repeated key must be answered, not refused`,
			)
		}

		const firstId = String(((first.responseBody ?? {}) as Record_)[ctx.identity])
		const secondId = String(((second.responseBody ?? {}) as Record_)[ctx.identity])
		if (firstId === secondId) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"replaying a request with the same idempotency key created a second record",
			`two identical POSTs carrying ${header}: "${key}" produced ${ctx.entityName} ${firstId} `
				+ `and ${secondId}. The header is declared, so clients will retry on timeouts assuming `
				+ "it protects them; every such retry silently duplicates the record.",
			[first, second],
		)
	},
}

/**
 * A route the document says a write invalidates must actually change.
 *
 * `x-invalidate` is the tag the whole entity graph is derived from, and until now it was believed
 * rather than tested: oat inverted the claim into a read surface and never asked whether the
 * claim was true. The interesting case is cross-entity — creating a child changes what the
 * *parent* route serves, via a denormalised counter or a cached projection. Those are the writes
 * that go wrong quietly: the write succeeds, the child's own listing is right, and only the other
 * route the document named is stale. Nothing but following the declaration finds it.
 *
 * Only routes belonging to a different entity are probed. This entity's own listing is already
 * covered by read-after-write, and re-asserting it here would report one defect twice.
 */
const declaredInvalidationHappens: Check = {
	applicable: (ctx) =>
		ctx.createOp !== undefined
		&& ctx.createOp.invalidates.some((route) => ctx.model.byRoute.get(route)?.entity !== ctx.entityName),
	dependsOn: ["list.read-after-write", "create.persists-submitted-fields"],
	id: "invalidation.declared-route-changes",
	mutates: true,
	needs: "a create operation whose x-invalidate names another entity's read route",
	async run(ctx) {
		const createOp = ctx.createOp
		if (createOp === undefined) return

		const foreign = createOp.invalidates
			.map((route) => ctx.model.byRoute.get(route))
			.filter(
				(op): op is OperationModel =>
					op !== undefined && op.entity !== ctx.entityName && op.method.toUpperCase() === "GET",
			)
		if (foreign.length === 0) return

		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the create operation declares no JSON request body, so no write can be made",
			)
		}

		/* Only routes whose path can be filled from this entity's scope are probed: a route
		 * needing an identifier oat does not hold would 404 for a reason unrelated to staleness. */
		const probes: Array<{ op: OperationModel; path: string }> = []
		for (const op of foreign) {
			const path = fillPath(op.path, ctx.scope)
			if (path.includes("{")) continue
			probes.push({ op, path })
		}
		if (probes.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the declared routes need identifiers outside this entity's scope, so they cannot be read",
			)
		}

		const before = new Map<string, string>()
		for (const probe of probes) {
			const exchange = await ctx.client.get(probe.path, { headers: ctx.auth() })
			if (exchange.status >= 400) continue
			before.set(probe.path, JSON.stringify(exchange.responseBody))
		}
		if (before.size === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"none of the declared routes could be read before the write",
			)
		}

		const created = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			body: validBody(ctx, schema),
			headers: ctx.auth(),
		})
		if (created.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the create returned ${created.status}, so nothing was invalidated`,
			)
		}

		for (const probe of probes) {
			const snapshot = before.get(probe.path)
			if (snapshot === undefined) continue
			const after = await ctx.client.get(probe.path, { headers: ctx.auth() })
			if (after.status >= 400) continue
			if (JSON.stringify(after.responseBody) !== snapshot) continue

			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a route the document says is invalidated by this write did not change",
				`creating a ${ctx.entityName} declares x-invalidate on "${probe.op.route}", but that `
					+ "route returned a byte-identical body before and after the write. Either it serves "
					+ "a value derived from this entity and that value is stale — a denormalised counter "
					+ "or a cached projection nobody refreshed — or the declaration is wrong and every "
					+ "client following it is invalidating the wrong cache key.",
				[created, after],
			)
			return
		}
	},
}

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
const projectionsAgree: Check = {
	applicable: (ctx) => ctx.readOp !== undefined && ctx.records.length > 0,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		/* Each projection is exercised elsewhere. When one is already known broken, its
		 * disagreement here is that same defect seen a second time. */
		"filter.equality-selects-exactly-one",
		"select.projection-honoured",
		"sort.order-is-applied",
	],
	id: "consistency.projections-agree",
	needs: "an item route and a record with a comparable field",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.readOp === undefined) return

		const id = String(target[ctx.identity])
		/*
		 * A filterable, sortable, non-null, *client-owned* field.
		 *
		 * Server-generated fields are excluded deliberately: a progress counter, a derived row
		 * count or a status the backend advances can legitimately differ between two reads taken
		 * moments apart, and since oat tests entities concurrently a derived value may move
		 * mid-check for reasons no read path is responsible for. Comparing those across
		 * projections measures timing, not consistency.
		 */
		const generated = new Set([
			...(ctx.createOp?.generated ?? []),
			...(ctx.updateOp?.generated ?? []),
		])
		const field = (ctx.query?.filterable ?? []).find(
			(name) =>
				name !== ctx.identity
				&& !generated.has(name)
				&& (ctx.query?.sortable ?? []).includes(name)
				&& target[name] !== null
				&& target[name] !== undefined
				&& typeof target[name] !== "object",
		)
		if (field === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no field is filterable, sortable and non-null on the sample record, so no single fact "
					+ "can be traced through every projection",
			)
		}

		const limit = ctx.query?.maxLimit ?? 100
		const seen: Array<{ projection: string; value: unknown }> = []
		const record = (result: ListResult): Record_ | undefined =>
			result.items.find((item) => String(item[ctx.identity]) === id)

		const detail = await ctx.client.get(
			fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }),
			{ headers: ctx.auth() },
		)
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
		const value = (detail.responseBody as Record_)[field]
		const rendered = String(value)

		const plain = await list(ctx, q(ctx, { limit }))
		const inList = record(plain)
		if (inList !== undefined) seen.push({ projection: "collection", value: inList[field] })

		const conventions = conv(ctx)
		if (conventions.select !== undefined) {
			const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
			const projected =
				projection === null ? null : await list(ctx, { ...q(ctx, { limit }), ...projection })
			const row = projected === null ? undefined : record(projected)
			if (row !== undefined) seen.push({ projection: "sparse fieldset", value: row[field] })
		}

		if (conventions.order !== undefined) {
			const sorted = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
			const row = record(sorted)
			if (row !== undefined) seen.push({ projection: "sorted page", value: row[field] })
		}

		const disagreeing = seen.filter(
			(entry) => JSON.stringify(entry.value) !== JSON.stringify(value),
		)
		if (disagreeing.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"the same record carries different values depending on how it is read",
				`${ctx.entityName} ${id} has "${field}" = ${JSON.stringify(value)} on the record oat `
					+ `created, but ${disagreeing
						.map((entry) => `the ${entry.projection} returns ${JSON.stringify(entry.value)}`)
						.join(", and ")}. At least one read path is serving something the others are not; `
					+ "a client's view of a record then depends on which route it happened to use.",
				[detail, plain.exchange],
			)
			return
		}

		/* Membership is a projection too: a filter that matches the value must return the record,
		 * its negation must not, and both are read off the same fact just proven consistent. */
		const matching = filterTerm(conventions, field, "eq", rendered)
		if (matching === null) return
		const included = await list(ctx, { ...q(ctx, { limit }), ...matching })
		if (included.exchange.status >= 400) return
		if (record(included) !== undefined) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a record is missing from a filter matching its own field value",
			`${ctx.entityName} ${id} carries "${field}" = ${JSON.stringify(value)} on every read path, `
				+ `yet filtering for exactly that value does not return it. The record and the predicate `
				+ "agree; the index or query that answers the filter does not.",
			[detail, included.exchange],
		)
	},
}

/**
 * Query axes must compose: a filter and a sort applied together must agree with each applied alone.
 *
 * Every other query check exercises one axis in isolation, and that is where the isolation stops
 * being realistic. Real backends break at the *combination*: adding a sort changes which index the
 * planner picks and the filter stops being applied; a cursor is resolved before the filter, so page
 * two leaks rows the predicate excluded; a count is computed on the unfiltered set the moment an
 * order is present. Each of those passes a suite that only ever tests one axis at a time.
 *
 * The property asserted is compositional, so it needs no ground truth: filtering then sorting must
 * yield exactly the same *set* as filtering alone — reordered, but never a different membership.
 * A sort is not a predicate, and it must not behave as one.
 */
const queryAxesCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx)
		&& conv(ctx).order !== undefined
		&& ctx.records.length > 2
		&& (ctx.query?.sortable.length ?? 0) > 0,
	dependsOn: [
		"list.read-after-write",
		/* Each axis has to work alone before "they disagree when combined" means anything. */
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honoured",
		/* Both sides are gathered by walking pages, so a walk that skips or repeats records
		 * changes the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "query.axes-compose",
	needs: "a filterable field, a sortable field, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100

		/*
		 * A field, and a value on it, selecting a *proper subset* of the cohort: more than one
		 * record so there is something to reorder, and fewer than all so a dropped predicate is
		 * visible as a change in membership. A value matching everything would make the filtered
		 * and unfiltered sets identical, and the check would pass whatever the backend did.
		 */
		let field: string | undefined
		let target: Record_ | undefined
		for (const candidate of ctx.query?.filterable ?? []) {
			if (candidate === ctx.identity) continue
			const values = ctx.records.map((record) => JSON.stringify(record[candidate]))
			const match = ctx.records.find((record) => {
				if (record[candidate] === null || record[candidate] === undefined) return false
				const count = values.filter((v) => v === JSON.stringify(record[candidate])).length
				return count > 1 && count < ctx.records.length
			})
			if (match !== undefined) {
				field = candidate
				target = match
				break
			}
		}
		if (field === undefined || target === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field holds a value shared by several records but not all of them, so "
					+ "no filter can select a proper subset to reorder",
			)
		}

		const sortField =
			(ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity)
			?? ctx.identity
		const term = filterTerm(conventions, field, "eq", String(target[field]))
		if (term === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`this API's filter grammar cannot express equality on "${field}"`,
			)
		}

		/*
		 * Both sides gathered across pages. Comparing single pages would compare two *windows* of
		 * the same set — a sorted page and an unsorted one legitimately hold different records once
		 * the set is larger than one page, and the difference would be read as a dropped filter.
		 */
		const filtered = await collectSet(ctx, limit, term)
		const both = await collectSet(
			ctx,
			limit,
			term,
			MAX_WALK_PAGES,
			sortTerm(conventions, sortField, "desc"),
		)
		if (filtered === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort was rejected, so the two cannot be compared",
			)
		}
		if (!filtered.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered set is larger than the walk covers, so the two runs cannot be compared "
					+ "as whole sets",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(both.items, ctx.identity))
		const missing = [...alone].filter((id) => !combined.has(id))
		const extra = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extra.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with `
				+ `order=${sortField} desc matched ${combined.size}. `
				+ (missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "")
				+ (extra.length > 0 ? `Appeared: ${extra.slice(0, 3).join(", ")}. ` : "")
				+ "Ordering must reorder a result, never change its membership — a filter that only "
				+ "holds while unsorted is one an index or query plan is silently dropping.",
			[filtered.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A filter must select from the whole collection, not from whichever page happened to be built.
 *
 * The failure this catches is one of *ordering of operations*: resolve the offset or cursor first,
 * then apply the predicate to whatever that window contained. Page one usually looks correct,
 * which is how it survives review — the damage is further in, where pages come back short and
 * matching records are never returned at all.
 *
 * The oracle needs no ground truth because oat can compute the answer two ways. Walk the
 * collection unfiltered and apply the predicate client-side; walk it again with the predicate
 * pushed to the server. A backend that filters before paging returns the same set both times. One
 * that pages first returns a subset, and the difference is exactly the records it skipped.
 */
const filterAndPagingCompose: Check = {
	applicable: (ctx) => filterable(ctx) && ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"filter.equality-selects-exactly-one",
		/* Both sides are walks, so a broken walk changes both for reasons that are not about
		 * where the predicate is applied. */
		"pagination.page-walk-covers-set",
		/* Both walks pin an explicit order so the two sets are comparable — which means a backend
		 * that stops applying the filter once a sort is present serves the *unfiltered* set to
		 * both sides, and nothing is ever missing. That defect has to be reported first; until it
		 * is fixed, where the predicate sits relative to paging cannot be observed at all. */
		"query.axes-compose",
	],
	id: "query.filter-selects-from-whole-set",
	needs: "a filterable field and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		/* A small page deliberately: the bug only shows once the window excludes matching rows,
		 * so a page large enough to hold the collection would hide it entirely. */
		const pageSize = Math.max(1, Math.min(2, ctx.query?.maxLimit ?? 2))

		const field = (ctx.query?.filterable ?? []).find((name) => {
			if (name === ctx.identity) return false
			const values = ctx.records.map((record) => JSON.stringify(record[name]))
			return ctx.records.some((record) => {
				if (record[name] === null || record[name] === undefined) return false
				const count = values.filter((v) => v === JSON.stringify(record[name])).length
				return count > 1 && count < ctx.records.length
			})
		})
		if (field === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field holds a value shared by several records but not all of them",
			)
		}
		const sample = ctx.records.find((record) => record[field] != null)
		if (sample === undefined) return
		const value = sample[field]

		const term = filterTerm(conventions, field, "eq", String(value))
		if (term === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`this API's filter grammar cannot express equality on "${field}"`,
			)
		}

		/*
		 * Both walks pinned to the same explicit order.
		 *
		 * A set gathered by paging is only well-defined if the pages come from a stable sequence.
		 * Left to the backend's default order — which may have no total order at all — two walks
		 * over the same collection legitimately return different sets, and the difference reads as
		 * a filter dropping records. Pinning the order removes that entirely rather than excusing
		 * it after the fact.
		 */
		const tiebreak = (ctx.query?.sortable ?? []).includes(ctx.identity) ? ctx.identity : undefined
		const walkOrder =
			tiebreak === undefined ? undefined : sortTerm(conventions, tiebreak, "asc")
		const everything = await collectSet(ctx, pageSize, {}, MAX_WALK_PAGES, walkOrder)
		const serverSide = await collectSet(ctx, pageSize, term, MAX_WALK_PAGES, walkOrder)
		if (everything === null || serverSide === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection could not be walked in both filtered and unfiltered form",
			)
		}
		if (!everything.complete || !serverSide.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two sets are not comparable",
			)
		}

		/* The predicate applied by oat, over everything the API served. */
		const clientSide = new Set(
			everything.items
				.filter((row) => JSON.stringify(row[field]) === JSON.stringify(value))
				.map((row) => String(row[ctx.identity])),
		)
		const returned = new Set(ids(serverSide.items, ctx.identity))
		const skipped = [...clientSide].filter((id) => !returned.has(id))
		if (skipped.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"paging a filtered query skips records that match the filter",
			`walking the collection at ${pageSize} per page and filtering client-side on `
				+ `"${field}" = ${JSON.stringify(value)} finds ${clientSide.size} record(s); asking the `
				+ `backend for the same filter returns ${returned.size}. Never returned: `
				+ `${skipped.slice(0, 3).join(", ")}. The page window is being computed before the `
				+ "predicate is applied, so matching records fall outside it and are lost — page one "
				+ "looks correct and later pages silently omit data.",
			[everything.last.exchange, serverSide.last.exchange],
		)
	},
}

/**
 * A capability the document declares must actually exist.
 *
 * `x-query.filterable` is a promise: every client generated from that document will offer a filter
 * on each field named there. When the backend rejects one, the backend is not necessarily wrong —
 * it is entitled to refuse a column it never indexed — but the *document* is, and it is wrong in
 * the most expensive way, because the failure only appears at runtime in someone else's client.
 *
 * oat is uniquely positioned to catch this: it is the only thing that reads the claim and then
 * tries it. Note the verdict is SPEC_BUG rather than BACKEND_BUG — the fix is to correct the
 * document or index the column, and saying which is not oat's call.
 *
 * This also closes a silent-skip: every filter check treats a 4xx as a capability statement and
 * stands down, which is right when the field was merely inferred and wrong when it was declared.
 */
const declaredFilterableWorks: Check = {
	applicable: (ctx) =>
		conv(ctx).filter !== undefined
		&& ctx.query?.source === "tag"
		&& (ctx.query?.filterable.length ?? 0) > 0
		&& ctx.records.length > 0,
	dependsOn: [
		"list.read-after-write",
		/* The evidence is a *rejection*. A backend that silently drops unknown filter fields never
		 * rejects anything, so an overclaimed field comes back 200 and this check would report the
		 * document as honest — the dropped-filter defect is the finding to act on first. */
		"filter.unknown-field-rejected",
		/* And only a 4xx counts: a backend whose filter parser throws answers *every* bad filter
		 * with a 500, which makes "the document declared a field the backend refuses"
		 * indistinguishable from "the parser is broken". That is the finding to fix first. */
		"error.malformed-filter-not-5xx",
	],
	id: "spec.declared-filterable-is-filterable",
	needs: "x-query naming filterable fields",
	async run(ctx) {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number }> = []
		let probed = 0

		for (const field of ctx.query?.filterable ?? []) {
			const sample = ctx.records.find((record) => record[field] != null)
			if (sample === undefined) continue
			const term = filterTerm(conventions, field, "eq", String(sample[field]))
			if (term === null) continue
			probed += 1
			const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...term })
			/* Only a rejection counts. A filter that returns the wrong rows is a backend defect
			 * other checks own; this one is strictly about the capability existing. */
			if (result.exchange.status >= 400 && result.exchange.status < 500) {
				rejected.push({ field, status: result.exchange.status })
			}
		}

		if (probed === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no declared filterable field holds a non-null value in the cohort, so none could be probed",
			)
		}
		if (rejected.length === 0) return

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a filter the backend does not accept",
			`x-query lists ${rejected.length} field(s) as filterable that the backend rejects: `
				+ `${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. `
				+ "Every client generated from this document will offer a filter that fails at runtime. "
				+ "Either the column needs an index or the declaration needs removing — but the "
				+ "document and the backend currently disagree about what this API can do.",
			[],
		)
	},
}

const crossTenantItemRead: Check = {
	applicable: (ctx) => ctx.altAuth !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
	id: "tenant.item-not-readable-cross-tenant",
	needs: "a second principal in a different tenant",
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

		/* Only assert a breach when the document says the route is tenant-scoped. Where oat merely
		 * guessed scoping from a path parameter, a shared catalogue and a data leak are the same
		 * observation, and claiming the worse one erodes trust in every other finding. */
		const declared = ctx.readOp.tenantSource === "tag"
		const detail =
			`${ctx.entityName} ${id} was created by one principal and read successfully ` +
			`(${exchange.status}) by a principal in a different tenant.`

		if (declared) {
			ctx.findings.security(
				this.id,
				ctx.entityName,
				"a record is readable by a principal in another tenant",
				`${detail} The operation declares x-tenant: "${ctx.readOp.tenantParam}", so this ` +
					"crosses a boundary the document states exists.",
				[exchange],
			)
			return
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${ctx.readOp.tenantParam}" path ` +
				"parameter; the document does not state it. If this resource is deliberately shared — " +
				"a public catalogue or gallery — this is correct behaviour and declaring x-tenant, or " +
				"omitting it, will settle it. If it is not shared, it is a cross-tenant read.",
			entity: ctx.entityName,
			evidence: [exchange],
			summary: "a record crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
	},
}

const crossTenantFilterBypass: Check = {
	applicable: (ctx) =>
		ctx.altAuth !== undefined &&
		ctx.altScope !== undefined &&
		filterable(ctx) &&
		ctx.records.length > 0,
	/* The probe filters, so anything that stops a filter from selecting over the whole collection
	 * hides the very record whose visibility is in question — a leak that cannot be observed is
	 * not a leak that can be reported. */
	dependsOn: ["query.filter-selects-from-whole-set"],
	id: "tenant.filter-does-not-bypass-scope",
	needs: "a second principal and a `filter` parameter",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.altAuth === undefined || ctx.altScope === undefined) return
		if (!(ctx.query?.filterable.includes(ctx.identity) ?? false)) return
		const id = String(target[ctx.identity])

		const tenantTerm = filterTerm(conv(ctx), ctx.identity, "eq", id)
		if (tenantTerm === null) return
		const result = await list(
			ctx,
			{ ...q(ctx, { limit: 100 }), ...tenantTerm },
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
	applicable: (ctx) => filterable(ctx),
	id: "error.malformed-filter-not-5xx",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	async run(ctx) {
		const result = await list(ctx, q(ctx, { filter: "((((", limit: 10 }))
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
	applicable: (ctx) => conv(ctx).limit !== undefined && ctx.records.length > 2,
	dependsOn: ["list.read-after-write"],
	id: "pagination.limit-bounds-page-size",
	needs: "a page-size query parameter named `limit`",
	async run(ctx) {
		const result = await list(ctx, q(ctx, { limit: 2 }))
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
		conv(ctx).limit !== undefined &&
		ctx.query?.maxLimit !== undefined &&
		/* Unless the collection holds more records than the cap, an uncapped backend and a
		 * capped one return the same thing and the check would prove nothing. */
		ctx.records.length > (ctx.query.maxLimit ?? Number.POSITIVE_INFINITY),
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.limit-respects-documented-max",
	needs: "a declared maxLimit, and more records than it",
	async run(ctx) {
		const max = ctx.query?.maxLimit
		if (max === undefined) return
		const result = await list(ctx, q(ctx, { limit: max + 50 }))
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
	applicable: (ctx) => pageable(ctx) && ctx.records.length > 2,
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.has-more-is-accurate",
	needs: "a way to page forward, and a more-pages signal in the body or a Link header",
	async run(ctx) {
		const first = await list(ctx, q(ctx, { limit: 1, page: 1 }))
		if (first.exchange.status >= 400 || first.items.length === 0) return
		const flag = envelopeValue(ctx, first, "hasMore")
		if (typeof flag !== "boolean") return

		const second = await list(ctx, q(ctx, { limit: 1, page: 2 }))
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
	needs: "an `order` parameter and a sortable field",
	async run(ctx) {
		const field = ctx.query?.sortable.find((f) => f !== ctx.identity) ?? ctx.query?.sortable[0]
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const ascending = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
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
		conv(ctx).search !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: ["list.read-after-write"],
	id: "search.q-narrows-result",
	needs: "a free-text `q` parameter and declared searchable fields",
	async run(ctx) {
		const field = ctx.query?.searchable[0]
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const all = await list(ctx, q(ctx, { limit }))
		if (all.items.length < 2) return

		/* A token no record can contain: a correct search returns nothing. */
		const result = await list(ctx, q(ctx, { limit, search: "zzqqxx-oat-no-match-token" }))
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
	needs: "a create operation that echoes the record back",
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
	mutates: true,
	id: "validation.enum-enforced",
	needs: "a request schema with an enum field",
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
	mutates: true,
	id: "validation.max-length-enforced",
	needs: "a request schema with a maxLength constraint",
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
	mutates: true,
	id: "validation.required-enforced",
	needs: "a request schema with a required field",
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
	mutates: true,
	id: "validation.content-type-enforced",
	needs: "a documented 415 response",
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
	needs: "a documented error schema on the item route",
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
	/* The body is validated against the schema declared *for the status that came back*. When the
	 * status itself is undocumented there is no schema to validate against, and the right finding
	 * is the status one — not silence. */
	dependsOn: ["create.status-matches-document"],
	id: "schema.success-response-matches-document",
	needs: "a documented success schema on create",
	async run(ctx) {
		const createOp = ctx.createOp
		const validator = ctx.validator
		if (createOp === undefined || validator === undefined) return
		const raw = ctx.model.rawOperations.get(createOp.operationId)
		if (raw === undefined) return

		const exchange = createExchange(ctx)
		if (exchange === undefined) return
		if (!validator.documents(raw, exchange.status)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`create returned ${exchange.status}, which the document declares no schema for — `
					+ "there is nothing to validate the body against",
			)
		}

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
/**
 * An operation declaring `x-effects` must produce exactly the stated change.
 *
 * `x-invalidate` says a read route changes; `x-effects` says *how*. That difference is what
 * separates "something differed" — which is satisfied by a stray timestamp and missed by a
 * cache-stale read — from an exact assertion on cardinality and membership.
 */
/**
 * A numeric field must compare numerically, not lexically.
 *
 * Query values arrive from a URL as text, and a backend that forgets to coerce them compares
 * "10" < "9" — so `amount.gt.9` silently omits 10, 20 and 100. The result is a plausible-looking
 * subset rather than an error, which is why it survives in production.
 */
const numericComparisonIsNumeric: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		numericFilterField(ctx) !== null &&
		ctx.records.length > 2,
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected"],
	id: "filter.numeric-comparison-is-numeric",
	needs: "a `filter` parameter and a numeric field",
	async run(ctx) {
		const field = numericFilterField(ctx)
		if (field === null) return

		const values = ctx.records
			.map((r) => r[field])
			.filter((v): v is number => typeof v === "number")
		if (values.length < 3) return

		/* A threshold that partitions the cohort, chosen so the lexical and numeric answers
		 * differ — comparing as text has to produce a visibly wrong set for this to prove
		 * anything. */
		const sorted = [...new Set(values)].sort((a, b) => a - b)
		const threshold = sorted[Math.floor(sorted.length / 2)]
		if (threshold === undefined) return

		const expected = ctx.records
			.filter((r) => typeof r[field] === "number" && (r[field] as number) > threshold)
			.map((r) => String(r[ctx.identity]))
			.sort()
		if (expected.length === 0) return

		const gtTerm = filterTerm(conv(ctx), field, "gt", threshold)
		if (gtTerm === null) return
		const result = await list(ctx, { ...q(ctx, { limit: ctx.query?.maxLimit ?? 100 }), ...gtTerm })
		if (result.exchange.status >= 400) return
		const got = ids(result.items, ctx.identity).sort()
		if (got.join(",") === expected.join(",")) return

		const missing = expected.filter((id) => !got.includes(id))
		const extra = got.filter((id) => !expected.includes(id))
		const lexical = expected.filter((id) => {
			const record = ctx.records.find((r) => String(r[ctx.identity]) === id)
			return record !== undefined && String(record[field]) < String(threshold)
		})

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			`"${field}" is compared as text rather than as a number`,
			`filter=${field}.gt.${threshold} returned ${got.length} record(s); ${expected.length} hold a ` +
				`greater numeric value. Missing: ${missing.slice(0, 4).join(", ") || "none"}. ` +
				`Unexpected: ${extra.slice(0, 4).join(", ") || "none"}. ` +
				(missing.length > 0 && missing.every((id) => lexical.includes(id))
					? "Every missing record is one whose value sorts below the threshold as a string, " +
						"so the comparison is lexical: the query value was never coerced from text."
					: "The comparison does not agree with numeric ordering."),
			[result.exchange],
		)
	},
}

function numericFilterField(ctx: CheckContext): string | null {
	for (const field of ctx.query?.filterable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => r[field])
		const numbers = values.filter((v) => typeof v === "number")
		if (numbers.length < 3) continue
		/* Only useful when text and numeric ordering actually disagree across the cohort. */
		const asNumbers = [...new Set(numbers as number[])].sort((a, b) => a - b)
		const asText = [...new Set(numbers as number[])].sort((a, b) => String(a).localeCompare(String(b)))
		if (asNumbers.join(",") !== asText.join(",")) return field
	}
	return null
}

/**
 * Concurrent writes to different fields must both survive.
 *
 * A handler that reads the row, then writes every column back — the `save(entity)` pattern —
 * reinstates whatever it read, so the later write silently reverts the earlier one. No error is
 * returned to either caller, which is what makes it so hard to notice from the outside.
 */
const noLostUpdate: Check = {
	applicable: (ctx) =>
		ctx.updateOp !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
	dependsOn: [
		"list.read-after-write",
		"patch.minimality",
		/* If writes do not persist at all, "the write was lost" describes a consequence rather
		 * than a concurrency defect. */
		"create.persists-submitted-fields",
	],
	id: "concurrency.no-lost-update",
	needs: "an update operation and two writable string fields",
	mutates: true,
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.updateOp === undefined || ctx.readOp === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const before = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		if (before.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back returned ${before.status}, so there was no baseline to race `
					+ "against",
			)
		}
		const original = (before.responseBody ?? {}) as Record_

		/* Two distinct writable string fields, so the writes cannot legitimately clobber each
		 * other — last-write-wins on the *same* field would be a defensible policy. */
		const fields = writableStringFields(ctx, original).slice(0, 2)
		const [first, second] = fields
		if (first === undefined || second === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`only ${fields.length} writable string field(s) are present on the record; two are `
					+ "needed so the concurrent writes cannot legitimately clobber each other",
			)
		}

		const path = fillPath(ctx.updateOp.path, params)
		const [firstWrite, secondWrite] = await Promise.all([
			ctx.client.request("PATCH", path, {
				body: { [first]: "oat-concurrent-a" },
				headers: ctx.auth(),
			}),
			ctx.client.request("PATCH", path, {
				body: { [second]: "oat-concurrent-b" },
				headers: ctx.auth(),
			}),
		])
		if (firstWrite.status >= 300 || secondWrite.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a concurrent PATCH was rejected (${firstWrite.status}, ${secondWrite.status}), so no `
					+ "race actually took place",
			)
		}

		const after = await ctx.client.get(fillPath(ctx.readOp.path, params), { headers: ctx.auth() })
		if (after.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back after the race returned ${after.status}`,
			)
		}
		const current = (after.responseBody ?? {}) as Record_

		const lost: string[] = []
		if (current[first] !== "oat-concurrent-a") lost.push(first)
		if (current[second] !== "oat-concurrent-b") lost.push(second)
		if (lost.length === 0) {
			return
		}

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a concurrent write to a different field was silently lost",
			`two simultaneous patches set "${first}" and "${second}" — different fields, so neither ` +
				`conflicts with the other — and both returned success, but ${lost.join(" and ")} ` +
				`read back as ${lost.map((f) => JSON.stringify(current[f])).join(", ")} afterwards. ` +
				"The update path reads the record and writes every column back, so whichever request " +
				"commits second reinstates the values it read before the first had committed. Callers " +
				"are told the write succeeded.",
			[firstWrite, secondWrite, after],
		)
	},
}

/**
 * Fields a probe may write an arbitrary string into without the backend having grounds to refuse.
 *
 * "Writable" is not enough: an enum, a pattern or a length cap makes an arbitrary value invalid,
 * and a backend that rejects or normalises it is behaving correctly. Reading that back as a lost
 * write turns sound validation into a fabricated concurrency bug — which is exactly what happened
 * when a probe value was written into a `status` enum.
 */
function writableStringFields(ctx: CheckContext, record: Record_): string[] {
	const immutable = new Set([...(ctx.updateOp?.immutable ?? []), ...(ctx.updateOp?.generated ?? [])])
	const schema = ctx.updateOp === undefined ? null : requestSchemaOf(ctx, ctx.updateOp)
	const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>

	/* Where the update body enumerates its properties, that list *is* the set of writable fields —
	 * a field the request schema does not mention is one the caller was never invited to send, and
	 * a backend is right to ignore it. Reading the record instead of the schema is what let a probe
	 * target `status` on an operation that only accepts `name`. */
	const enumerated = Object.keys(properties).length > 0

	const out: string[] = []
	for (const [key, value] of Object.entries(record)) {
		if (immutable.has(key) || key === ctx.identity) continue
		if (/_at$|_id$/.test(key)) continue
		if (typeof value !== "string") continue

		const declared = properties[key]
		if (enumerated && declared === undefined) continue
		if (declared !== undefined) {
			if (Array.isArray(declared.enum)) continue
			if (typeof declared.pattern === "string") continue
			if (typeof declared.format === "string") continue
			/* The probe values are short, but a cap tight enough to reject them would make the
			 * write fail for a reason that has nothing to do with concurrency. */
			if (typeof declared.maxLength === "number" && declared.maxLength < 32) continue
		}
		out.push(key)
	}
	return out
}

const declaredEffectsOccur: Check = {
	applicable: (ctx) => ctx.effectOps.length > 0,
	dependsOn: ["list.read-after-write"],
	mutates: true,
	id: "effects.declared-effect-occurs",
	needs: "an operation declaring x-effects",
	async run(ctx) {
		for (const op of ctx.effectOps) {
			for (const effect of op.effects) {
				const target = ctx.model.entities.get(effect.entity)
				const listId = target?.list
				if (listId === undefined) {
					ctx.findings.gap(
						this.id,
						ctx.entityName,
						`${op.operationId} declares an effect on "${effect.entity}", which has no list route`,
						"the effect cannot be observed, so it is not verified",
					)
					continue
				}
				const listOp = ctx.model.byOperationId.get(listId)
				if (listOp === undefined) continue

				const before = await observe(ctx, listOp)
				if (before === null) continue

				const body = op.hasRequestBody ? validBody(ctx, requestSchemaOf(ctx, op) ?? {}) : undefined
				const invoked = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					...(body === undefined ? {} : { body }),
				})
				if (invoked.status >= 400) {
					ctx.findings.gap(
						this.id,
						ctx.entityName,
						`${op.operationId} could not be invoked`,
						`returned ${invoked.status}; its declared effects are unverified`,
					)
					continue
				}

				const after = await observe(ctx, listOp)
				if (after === null) continue

				const expected = effect.count ?? 1
				const delta = after.ids.length - before.ids.length
				const added = after.ids.filter((id) => !before.ids.includes(id))
				const removed = before.ids.filter((id) => !after.ids.includes(id))

				const wanted =
					effect.op === "create" || effect.op === "append"
						? expected
						: effect.op === "delete"
							? -expected
							: 0

				if (effect.op === "create" || effect.op === "append") {
					if (delta === wanted && added.length === expected) continue
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						`${op.operationId} did not produce the "${effect.entity}" records it declares`,
						`x-effects declares ${effect.op} × ${expected} on "${effect.entity}", but the ` +
							`collection went from ${before.ids.length} to ${after.ids.length} ` +
							`(${added.length} added, ${removed.length} removed). A declared effect that does ` +
							"not occur means callers cannot rely on the operation having done anything.",
						[invoked, after.exchange],
					)
					continue
				}

				if (effect.op === "delete") {
					if (delta === wanted && removed.length === expected) continue
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						`${op.operationId} did not remove the "${effect.entity}" records it declares`,
						`x-effects declares delete × ${expected} on "${effect.entity}", but the collection ` +
							`went from ${before.ids.length} to ${after.ids.length}`,
						[invoked, after.exchange],
					)
					continue
				}

				/* update and replace change content, not cardinality. */
				if (delta !== 0) {
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						`${op.operationId} changed the size of "${effect.entity}" while declaring ${effect.op}`,
						`x-effects declares ${effect.op}, which must not add or remove records, but the ` +
							`collection went from ${before.ids.length} to ${after.ids.length}`,
						[invoked, after.exchange],
					)
				}
			}
		}
	},
}

async function observe(
	ctx: CheckContext,
	listOp: OperationModel,
): Promise<{ ids: string[]; exchange: Exchange } | null> {
	let path: string
	try {
		path = fillPath(listOp.path, ctx.scope)
	} catch {
		return null
	}
	const exchange = await ctx.client.get(path, {
		headers: ctx.auth(),
		query: { limit: listOp.query?.maxLimit ?? 100 },
	})
	if (exchange.status >= 400) return null
	const identity = ctx.model.entities.get(listOp.entity ?? "")?.identity ?? "id"
	const items = extractItems(exchange.responseBody, listOp.collection?.key ?? null)
	return { exchange, ids: items.map((item) => String(item[identity])) }
}

const asyncReachesTerminalState: Check = {
	applicable: (ctx) => ctx.asyncOps.length > 0,
	mutates: true,
	id: "async.reaches-terminal-state",
	needs: "an operation declaring x-async",
	async run(ctx) {
		for (const op of ctx.asyncOps) {
			const spec = op.async
			if (spec === null) continue

			const body = op.hasRequestBody
				? validBody(ctx, requestSchemaOf(ctx, op) ?? {})
				: undefined
			const start = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
				headers: ctx.auth(),
				...(body === undefined ? {} : { body }),
			})
			if (start.status >= 400) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${op.operationId} could not be started`,
					`returned ${start.status}; the async lifecycle after it is untested`,
				)
				continue
			}

			const outcome = await driveAsync(
				ctx.client,
				spec,
				start.responseBody,
				ctx.scope,
				ctx.auth(),
			)

			if (outcome.timedOut) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					`${op.operationId} never reached a terminal state`,
					`polled ${spec.poll} ${outcome.polls} time(s) over ${Math.round(outcome.elapsedMs)}ms ` +
						`without satisfying "${spec.until ?? "any terminal state"}". A job that neither ` +
						"completes nor fails leaves callers polling forever.",
					[start, ...outcome.exchanges.slice(-2)],
				)
				continue
			}

			if (outcome.terminal === null) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					`${op.operationId} job disappeared before completing`,
					`the poll route stopped serving the job after ${outcome.polls} poll(s). A job that ` +
						"vanishes is indistinguishable from one that never existed.",
					[start, ...outcome.exchanges.slice(-2)],
				)
				continue
			}

			if (!outcome.succeeded) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${op.operationId} reached a non-success terminal state`,
					`terminal state did not satisfy "${spec.successWhen ?? ""}"; downstream effects of ` +
						"this operation are untested",
				)
			}
		}
	},
}

const asyncReceiptIsResolvable: Check = {
	applicable: (ctx) => ctx.asyncOps.some((op) => op.async?.idFrom !== undefined),
	id: "async.receipt-identifies-the-job",
	needs: "x-async with an idFrom pointer",
	async run(ctx) {
		for (const op of ctx.asyncOps) {
			const spec = op.async
			if (spec?.idFrom === undefined) continue

			/* Match the async operation's own exchange by resolved path — any POST would do here
			 * otherwise, and a sibling create's response would be inspected instead. */
			let resolved: string
			try {
				resolved = fillPath(op.path, ctx.scope)
			} catch {
				continue
			}
			const started = ctx.client.transcript.find(
				(e) => e.method === op.method && e.status < 300 && new URL(e.url).pathname === resolved,
			)
			if (started === undefined) continue

			const body = started.responseBody
			const path = spec.idFrom.replace(/^\$\.?/, "").split(".").filter(Boolean)
			let node: unknown = body
			for (const segment of path) {
				if (node === null || typeof node !== "object") {
					node = undefined
					break
				}
				node = (node as Record<string, unknown>)[segment]
			}
			if (node !== undefined && node !== null) continue

			ctx.findings.spec(
				this.id,
				ctx.entityName,
				`${op.operationId} response does not carry the job identifier it declares`,
				`x-async names "${spec.idFrom}" as the job id, but the response has no such value. ` +
					"Callers cannot poll for a job they cannot name.",
				[started],
			)
		}
	},
}

export const CHECKS: readonly Check[] = [
	/* foundations — did the write land, is it visible, and do the paging primitives work at all.
	 * Everything below assumes these hold, so they must be evaluated first for cascade
	 * suppression to have anything to consult. */
	readAfterWrite,
	createPersistsFields,
	createStatusMatchesSpec,
	successSchemaHonoured,
	errorSchemaHonoured,
	limitBoundsPageSize,
	limitRespectsMax,
	hasMoreIsAccurate,
	/* Ordering and the page walk are foundations too, not query niceties: the set-algebra checks
	 * below gather their sets *across pages*, so a broken walk would corrupt the very sets they
	 * compare. Establishing paging first is what lets those failures be suppressed as cascades
	 * rather than re-reported once per predicate. */
	orderChangesResult,
	pageWalkCoversSet,
	cursorAgreesWithPage,

	/* query semantics */
	unknownFilterRejected,
	malformedFilterNot5xx,
	equalityFilterSelectsOne,
	zeroMatchFilter,
	negationPartitions,
	likeEscaping,
	sortReverseSymmetry,
	searchNarrowsResult,
	selectProjection,
	countIsConsistentWithPage,
	countMatchesWalk,
	numericComparisonIsNumeric,

	/* write semantics */
	patchMinimality,
	immutableRejected,
	idempotentReplay,
	declaredInvalidationHappens,
	projectionsAgree,
	queryAxesCompose,
	filterAndPagingCompose,
	declaredFilterableWorks,
	noLostUpdate,
	deleteMissingIs404,
	softDeleteHidden,

	/* input validation */
	enumValidated,
	maxLengthValidated,
	requiredValidated,
	contentTypeEnforced,

	/* isolation */
	crossTenantItemRead,
	denialDoesNotRevealExistence,
	crossTenantFilterBypass,

	/* declared side effects and async lifecycles, last: both invoke operations that change the
	 * world, and both are meaningless if the read surface above is already known broken */
	declaredEffectsOccur,
	asyncReachesTerminalState,
	asyncReceiptIsResolvable,
]
