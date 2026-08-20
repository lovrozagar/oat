/**
 * The check registry.
 *
 * Each check asserts one property that must hold for any correct implementation. They need no
 * ground truth — they compare the API against itself, through independent projections, or against
 * the oracle of what oat just wrote. Check ids are stable: the conformance suite asserts on them.
 */

import type { Hooks } from "../config/define-config.ts"
import { canWriteFilterOp, filterTerm, selectTerm, sortTerm, sortTermWithNulls } from "../spec/conventions.ts"
import type { InviteSpec } from "../spec/extensions.ts"
import type { QueryCapability } from "../spec/extensions.ts"
import {
	type EffectiveFilterField,
	type EffectiveQueryCapabilities,
	FILTER_OPS,
	ORDERED_TYPES,
	fieldAllows,
	fieldAllowsNulls,
	isFilterOp,
	mergeQueryCapabilities,
	opsAreClosed,
	opsForField,
} from "../spec/query-capabilities.ts"
import { requestContent } from "../spec/collection.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { pathTemplateMatches } from "../spec/load.ts"
import type { OperationObject } from "../spec/types.ts"
import { encodeForOperation } from "./body.ts"
import type { Client, Exchange, RequestOptions } from "./client.ts"
import { STRING_PAYLOADS, payloadFits } from "./payloads.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial, reportFeatureGateSchemaDrift } from "./feature-gate.ts"
import type { FindingCollector } from "./finding.ts"
import { driveAsync, inspectStreamAsync, matchesPredicate, resolveAsyncId } from "./async.ts"
import { resolveOutOfBandValue } from "./auth.ts"
import { buildCohort } from "./fixture.ts"
import type { BackoffConfig } from "./poll.ts"
import type { UploadContext } from "./upload.ts"
import { forEachInvocation } from "./upload-each.ts"
import type { SchemaValidator } from "./validate.ts"
import { driveWait } from "./wait.ts"
import { type Record_, fillPath } from "./world.ts"
import {
	bindAfterCreateEffects,
	bindCreatedScope,
	bindMissingPathParams,
	canFillPath,
	describeEffectHold,
	effectHolds,
	identityPathParam,
} from "./effects.ts"

/** A resolved principal as checks see it — identity, lattice position, and how to speak as it. */
export interface Actor {
	id: string
	role: string | undefined
	/** Higher can do everything a lower rank can. Same rank = peers. */
	rank: number
	headers: () => Record<string, string>
	/** Tenant identity from config / the auth flow — not the full path scope. */
	roots: Record<string, string>
	scope: Record<string, string>
	/** Value the owner puts in an invite body for this principal. */
	inviteAs: string | undefined
}

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
	/** Merged filter catalog. Optional so a hand-built context still works. */
	capabilities?: EffectiveQueryCapabilities
	softDelete: string | null
	invite: InviteSpec | null
	auth: () => Record<string, string>
	/** Countdown / 401 refresh for the writer principal. Bound onto the client as well. */
	refreshIfStale?: (force?: boolean) => Promise<void>
	/**
	 * Every configured principal, primary first. Isolation checks still use `altAuth` (the first
	 * actor whose scope is a different tenant). Lattice checks walk this list by `rank`.
	 */
	actors: Actor[]
	/** Principal in a different tenant, when one is configured. Derived, not `principals[1]`. */
	altAuth: (() => Record<string, string>) | undefined
	altScope: Record<string, string> | undefined
	validator: SchemaValidator | undefined
	seed: number
	/** File pool / dummy resolution for multipart parts. */
	uploads: UploadContext
	/** Operations on this entity declared async via `x-async`. */
	asyncOps: OperationModel[]
	/** Operations on this entity that declare `x-effects`. */
	effectOps: OperationModel[]
	/** Operations on this entity that declare `x-wait`. */
	waitOps: OperationModel[]
	hooks: Hooks
	outOfBand: BackoffConfig
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

/**
 * A documented feature-gate 403 is not a 2xx-check failure and not SECURITY.
 *
 * The check that needed a success stands down with a named gap. The 403 body is still
 * validated against the documented error schema — coverage is not a free pass for drift.
 */
function standDownForFeatureGate(
	ctx: CheckContext,
	op: OperationModel | undefined,
	exchange: Exchange,
	check: string,
): boolean {
	if (op === undefined) return false
	if (!isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) return false
	if (ctx.validator !== undefined) {
		reportFeatureGateSchemaDrift(
			ctx.findings,
			ctx.validator,
			op,
			ctx.model.rawOperations.get(op.operationId),
			exchange,
			ctx.entityName,
		)
	}
	ctx.findings.gap(
		check,
		ctx.entityName,
		`${op.operationId} did not apply`,
		`${describeFeatureGate(op, exchange.responseBody)}. The check that needed a 2xx stands ` +
			"down rather than treat the documented 403 as a defect.",
	)
	return true
}

/**
 * A 429 that survived Client retries is the bucket, not the backend. The check that needed a
 * 2xx stands down; it is not a defect and it is not a concurrency conclusion.
 */
function standDownForRateLimit(ctx: CheckContext, exchange: Exchange, check: string): boolean {
	if (exchange.status !== 429) return false
	ctx.findings.unresolved(
		check,
		ctx.entityName,
		"the request was rate-limited (429) after retries, so this check could not complete",
	)
	return true
}

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
		searchMode?: string | undefined
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
	if (roles.searchMode !== undefined && c.searchMode !== undefined) out[c.searchMode] = roles.searchMode
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

function resolvedCaps(ctx: CheckContext): EffectiveQueryCapabilities {
	if (ctx.capabilities !== undefined) return ctx.capabilities
	return mergeQueryCapabilities({
		itemSchema: ctx.listOp.collection?.itemSchema ?? null,
		tag:
			ctx.query === null
				? null
				: {
						filterable: ctx.query.filterable,
						searchable: ctx.query.searchable,
						selectable: ctx.query.selectable,
						sortable: ctx.query.sortable,
						source: ctx.query.source,
						...(ctx.query.filterableDeclared === undefined ? {} : { filterableDeclared: ctx.query.filterableDeclared }),
						...(ctx.query.sortableDeclared === undefined ? {} : { sortableDeclared: ctx.query.sortableDeclared }),
						...(ctx.query.searchableDeclared === undefined ? {} : { searchableDeclared: ctx.query.searchableDeclared }),
						...(ctx.query.selectableDeclared === undefined ? {} : { selectableDeclared: ctx.query.selectableDeclared }),
						...(ctx.query.filterFields === undefined ? {} : { filterFields: ctx.query.filterFields }),
						...(ctx.query.sortableFields === undefined ? {} : { sortableFields: ctx.query.sortableFields }),
						...(ctx.query.catalog === undefined ? {} : { catalog: ctx.query.catalog }),
						...(ctx.query.defaultOrder === undefined ? {} : { defaultOrder: ctx.query.defaultOrder }),
						...(ctx.query.stableTiebreak === undefined ? {} : { stableTiebreak: ctx.query.stableTiebreak }),
					},
	})
}

function filterableNames(ctx: CheckContext): string[] {
	return resolvedCaps(ctx).filterable.map((field) => field.field)
}

/** Filter field for identity predicates when it differs from the JSON identity. */
function filterIdentity(ctx: CheckContext): string {
	return resolvedCaps(ctx).identityFilter ?? ctx.identity
}

function identityIsFilterable(ctx: CheckContext): boolean {
	const names = filterableNames(ctx)
	return names.includes(filterIdentity(ctx)) || names.includes(ctx.identity)
}

function fieldByName(ctx: CheckContext, name: string): EffectiveFilterField | undefined {
	return resolvedCaps(ctx).filterable.find((field) => field.field === name)
}

function canUseOp(ctx: CheckContext, field: EffectiveFilterField, op: (typeof FILTER_OPS)[number]): boolean {
	return canWriteFilterOp(conv(ctx), op) && fieldAllows(field, op, resolvedCaps(ctx))
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
		operationId: ctx.listOp.operationId,
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
/** Hard cap so a live collection of thousands cannot turn one check into a crawl. */
const WALK_RECORD_CAP = 200

/** Pages needed to cover `total` rows at `pageSize`, never fewer than the default bound. */
function pagesToCover(total: number | undefined, pageSize: number): number {
	const size = Math.max(1, pageSize)
	if (total === undefined || !Number.isFinite(total) || total < 0) return MAX_WALK_PAGES
	const needed = Math.ceil(total / size) + 1
	const cap = Math.ceil(WALK_RECORD_CAP / size)
	return Math.min(cap, Math.max(MAX_WALK_PAGES, needed))
}

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
	return filterableNames(ctx).find(predicate) ?? null
}

function fieldsAllowing(ctx: CheckContext, op: (typeof FILTER_OPS)[number]): EffectiveFilterField[] {
	if (!canWriteFilterOp(conv(ctx), op)) return []
	return resolvedCaps(ctx).filterable.filter((field) => fieldAllows(field, op, resolvedCaps(ctx)))
}

function distinctValues(records: Record_[], field: string): unknown[] {
	const seen = new Set<string>()
	const out: unknown[] = []
	for (const record of records) {
		const value = record[field]
		if (value === null || value === undefined) continue
		const key = String(value)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(value)
	}
	return out
}

function asTermValue(value: unknown): string | number {
	return typeof value === "number" ? value : String(value)
}

function setOf(records: Record_[], identity: string): Set<string> {
	return new Set(ids(records, identity))
}

/** List identities that oat seeded. Extra rows outside this set are not scored as defects. */
function knownHits(items: Record_[], ctx: CheckContext): Set<string> {
	const known = setOf(ctx.records, ctx.identity)
	return new Set(ids(items, ctx.identity).filter((id) => known.has(id)))
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const item of a) if (!b.has(item)) return false
	return true
}

/**
 * Finds a record holding non-null values on two distinct, non-identity filterable fields — the
 * minimum needed to build a compound predicate that is guaranteed to match at least that record.
 */
function twoFilterableFields(ctx: CheckContext): { fieldA: string; fieldB: string; target: Record_ } | null {
	const skip = new Set([ctx.identity, filterIdentity(ctx)])
	const candidates = filterableNames(ctx).filter((f) => !skip.has(f))
	for (const target of ctx.records) {
		const present = candidates.filter((f) => target[f] !== null && target[f] !== undefined)
		if (present[0] !== undefined && present[1] !== undefined) {
			return { fieldA: present[0], fieldB: present[1], target }
		}
	}
	return null
}

/** The bare `field.op.value` / `field=op:value` fragment `filterTerm` wraps in its parameter. */
function filterFragment(conventions: ReturnType<typeof conv>, field: string, value: string): string | null {
	const term = filterTerm(conventions, field, "eq", value)
	if (term === null) return null
	const fragment = Object.values(term)[0]
	return typeof fragment === "string" ? fragment : null
}

/**
 * A conjunction of two equality predicates, in whatever grammar the endpoint speaks.
 *
 * Per-field equality ANDs implicitly — two query parameters together already mean "both must
 * hold" — so the two terms are simply merged. A raw filter expression has no such shortcut: the
 * postgrest grammar needs an explicit `and(...)`, and the colon grammar (which has no grouping
 * syntax at all — see `toCanonicalFilter`) ANDs by joining terms with a comma.
 */
function andTerm(
	conventions: ReturnType<typeof conv>,
	fieldA: string,
	valueA: string,
	fieldB: string,
	valueB: string,
): Record<string, string> | null {
	if (conventions.grammar === "equality") {
		const a = filterTerm(conventions, fieldA, "eq", valueA)
		const b = filterTerm(conventions, fieldB, "eq", valueB)
		if (a === null || b === null) return null
		return { ...a, ...b } as Record<string, string>
	}
	if (conventions.filter === undefined) return null
	const a = filterFragment(conventions, fieldA, valueA)
	const b = filterFragment(conventions, fieldB, valueB)
	if (a === null || b === null) return null
	return { [conventions.filter]: conventions.grammar === "postgrest" ? `and(${a},${b})` : `${a},${b}` }
}

/**
 * A disjunction of two equality predicates.
 *
 * Only the postgrest grammar has an `or()` combinator at all: per-field equality has no way to
 * ask for "either" rather than "both", and the colon grammar's comma join is AND-only.
 */
function orTerm(
	conventions: ReturnType<typeof conv>,
	fieldA: string,
	valueA: string,
	fieldB: string,
	valueB: string,
): Record<string, string> | null {
	if (conventions.grammar !== "postgrest" || conventions.filter === undefined) return null
	const a = filterFragment(conventions, fieldA, valueA)
	const b = filterFragment(conventions, fieldB, valueB)
	if (a === null || b === null) return null
	return { [conventions.filter]: `or(${a},${b})` }
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
		/*
		 * Walk by short page, never by `hasMore`. Trusting the flag is the same trap
		 * {@link isComplete} documents: a backend whose more-pages signal is wrong makes a
		 * record on page two look like a lost write.
		 *
		 * Deliberately unsorted. STALE_LIST only freezes the default listing — adding `order`
		 * takes a live path and the defect vanishes. An unstable default order can hide a
		 * record for one walk; a repeat that finds it was never a lost write.
		 */
		const locate = async (): Promise<{
			status: "found" | "missing" | "unresolved"
			last: ListResult | null
		}> => {
			const gathered = await collectSet(ctx, pageSize)
			if (gathered === null) return { last: null, status: "unresolved" }
			if (gathered.items.some((item) => String(item[ctx.identity]) === id)) {
				return { last: gathered.last, status: "found" }
			}
			return { last: gathered.last, status: "missing" }
		}

		let located = await locate()
		/* A record that appears on a repeat walk was never lost — it was unreachable for one
		 * query. That is an ordering defect, which the pagination checks diagnose precisely;
		 * reporting it here as a lost write would name the wrong cause. This check is about
		 * records the list *never* shows. */
		for (let attempt = 0; attempt < 2 && located.status === "missing"; attempt++) {
			located = await locate()
		}
		if (located.status === "found") return
		if (located.status === "unresolved") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the list was rejected, so whether the write is visible cannot be decided",
			)
		}

		const evidence: Exchange[] = located.last === null ? [] : [located.last.exchange]
		let detail = `created ${ctx.entityName} ${id} is absent from the list projection`
		if (ctx.readOp !== undefined) {
			const item = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
				headers: ctx.auth(),
			})
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

/**
 * Isolation checks need a tenant boundary to have meaning. A public catalogue has neither
 * `x-tenant` nor a path parameter that looks like one; a 200 from another principal is the
 * contract, not a leak.
 */
function tenantBoundary(op: OperationModel | undefined): boolean {
	if (op === undefined) return false
	return !(op.tenantSource === null && (op.tenantParam === null || op.tenantParam === undefined))
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
				`filtering on an undeclared field returned ${result.exchange.status}; a rejected input ` + "should be a 4xx",
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
	applicable: (ctx) => filterable(ctx) && ctx.records.length > 0 && identityIsFilterable(ctx),
	dependsOn: ["list.read-after-write"],
	id: "filter.equality-selects-exactly-one",
	needs: "a `filter` parameter that accepts the identity field",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const field = filterIdentity(ctx)
		const term = filterTerm(conv(ctx), field, "eq", id)
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
			`filter=${field}.eq.${id} returned ${got.length} records (${got.slice(0, 5).join(", ")})`,
			[result.exchange],
		)
	},
}

const zeroMatchFilter: Check = {
	applicable: (ctx) => filterable(ctx) && identityIsFilterable(ctx),
	dependsOn: ["list.read-after-write"],
	id: "filter.zero-match-returns-none",
	needs: "a `filter` parameter that accepts the identity field",
	async run(ctx) {
		const term = filterTerm(conv(ctx), filterIdentity(ctx), "eq", "oat-nonexistent-value-000")
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
	applicable: (ctx) => filterable(ctx) && ctx.records.length > 1 && identityIsFilterable(ctx),
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
		const field = nullableField(ctx, filterableNames(ctx)) ?? filterIdentity(ctx)
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
				"the collection is larger than the walk covers, so the union cannot be compared " + "against the whole set",
			)
		}

		const union = new Set([...ids(matching.items, ctx.identity), ...ids(complement.items, ctx.identity)])
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

/**
 * Every filter check above uses a single predicate. Real filters compose them: `and(a,b)`,
 * `or(a,b)`, and nested combinations of both. This is the first of two checks giving that
 * combinator its own set-algebra property, needing no ground truth just like the rest: a
 * conjunction of two predicates must select exactly the intersection of what each selects alone.
 */
const filterAndComposesAsIntersection: Check = {
	applicable: (ctx) => filterable(ctx) && (ctx.query?.filterable.length ?? 0) > 1,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		/* Both sides are gathered across pages, so a walk that skips or repeats records changes
		 * the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.and-composes-as-intersection",
	needs: "two filterable fields and a filter parameter or grammar supporting eq",
	async run(ctx) {
		const conventions = conv(ctx)
		const picked = twoFilterableFields(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no record holds non-null values on two distinct filterable fields to combine",
			)
		}
		const { fieldA, fieldB, target } = picked
		const valueA = String(target[fieldA])
		const valueB = String(target[fieldB])
		const termA = filterTerm(conventions, fieldA, "eq", valueA)
		const termB = filterTerm(conventions, fieldB, "eq", valueB)
		const combined = andTerm(conventions, fieldA, valueA, fieldB, valueB)
		if (termA === null || termB === null || combined === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"this API's filter grammar cannot express a combined predicate",
			)
		}

		const limit = ctx.query?.maxLimit ?? 100
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const both = await collectSet(ctx, limit, combined)
		if (onlyA === null || onlyB === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the intersection was rejected",
			)
		}
		if (!onlyA.complete || !onlyB.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the intersection cannot be verified",
			)
		}

		const setA = new Set(ids(onlyA.items, ctx.identity))
		const setB = new Set(ids(onlyB.items, ctx.identity))
		const expected = new Set([...setA].filter((id) => setB.has(id)))
		const got = new Set(ids(both.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extra = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extra.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and() does not compose as the intersection of its terms",
			`and(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose intersection is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but should not match both terms: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A conjunction must select exactly the records both terms match individually.",
			[onlyA.last.exchange, onlyB.last.exchange, both.last.exchange],
		)
	},
}

/**
 * The disjunction counterpart of {@link filterAndComposesAsIntersection}: `or(a,b)` must select
 * exactly the union of what each predicate selects alone. Only the postgrest-shaped grammar has
 * an `or()` combinator at all — per-field equality and the colon grammar's comma join are both
 * AND-only — so this stands down everywhere else rather than inventing a request to send.
 */
const filterOrComposesAsUnion: Check = {
	applicable: (ctx) => conv(ctx).grammar === "postgrest" && (ctx.query?.filterable.length ?? 0) > 1,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"pagination.page-walk-covers-set",
		/* Deliberately does *not* depend on filter.and-composes-as-intersection: and() and or()
		 * being broken by the same defect is two independent manifestations of one root cause, not
		 * one causing the other. A defect that swaps the combinators corrupts both requests, and
		 * suppressing this as and()'s cascade would hide the half of the bug this check is the
		 * only thing that can see. */
	],
	id: "filter.or-composes-as-union",
	needs: "two filterable fields and an or() combinator (postgrest-shaped filter grammar)",
	async run(ctx) {
		const conventions = conv(ctx)
		const picked = twoFilterableFields(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no record holds non-null values on two distinct filterable fields to combine",
			)
		}
		const { fieldA, fieldB, target } = picked
		const valueA = String(target[fieldA])
		const valueB = String(target[fieldB])
		const termA = filterTerm(conventions, fieldA, "eq", valueA)
		const termB = filterTerm(conventions, fieldB, "eq", valueB)
		const combined = orTerm(conventions, fieldA, valueA, fieldB, valueB)
		if (termA === null || termB === null || combined === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"this API's filter grammar cannot express a combined predicate",
			)
		}

		const limit = ctx.query?.maxLimit ?? 100
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const either = await collectSet(ctx, limit, combined)
		if (onlyA === null || onlyB === null || either === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the union was rejected",
			)
		}
		if (!onlyA.complete || !onlyB.complete || !either.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be verified",
			)
		}

		const setA = new Set(ids(onlyA.items, ctx.identity))
		const setB = new Set(ids(onlyB.items, ctx.identity))
		const expected = new Set([...setA, ...setB])
		const got = new Set(ids(either.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extra = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extra.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"or() does not compose as the union of its terms",
			`or(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose union is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but matches neither term individually: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A disjunction must select exactly the records either term matches alone.",
			[onlyA.last.exchange, onlyB.last.exchange, either.last.exchange],
		)
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
			return ctx.findings.unresolved(this.id, ctx.entityName, "no sortable field is available to order by")
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
				"the collection is larger than the walk covers, so the two directions return " +
					"different windows of it rather than the same set reversed",
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
		if (!identityIsFilterable(ctx)) return
		const target = ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const countTerm = filterTerm(conv(ctx), filterIdentity(ctx), "eq", id)
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
			control === undefined ? undefined : { ...ctx.scope, ...itemParamFor(ctx, String(control[ctx.identity])) }
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
			/* A job's progress counter advances on GET without this PATCH having written it. */
			"progress",
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
		if (standDownForFeatureGate(ctx, ctx.updateOp, patched, this.id)) return
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
				collateral = collateral.filter((key) => JSON.stringify(from[key]) === JSON.stringify(to[key]))
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
		ctx.updateOp !== undefined &&
		ctx.readOp !== undefined &&
		ctx.updateOp.immutable.length > 0 &&
		ctx.records.length > 0,
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
		if (standDownForFeatureGate(ctx, ctx.updateOp, patched, this.id)) return
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
		if (standDownForFeatureGate(ctx, ctx.deleteOp, exchange, this.id)) return
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
		if (standDownForFeatureGate(ctx, ctx.deleteOp, deleted, this.id)) return
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
		ctx.altAuth !== undefined && ctx.readOp !== undefined && ctx.records.length > 0 && tenantBoundary(ctx.readOp),
	dependsOn: [
		/* If the record is readable across tenants at all, that is the finding — how the denial
		 * would have been phrased is beside the point. */
		"tenant.item-not-readable-cross-tenant",
	],
	id: "tenant.denial-does-not-reveal-existence",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.readOp === undefined || ctx.altAuth === undefined) return
		const realId = String(target[ctx.identity])
		/* Shaped like a real identifier so the difference under test is existence, not format —
		 * a backend may legitimately reject a malformed id differently. */
		const absentId = `${realId}-oat-absent`

		const ask = async (id: string): Promise<Exchange> =>
			ctx.client.get(fillPath(ctx.readOp?.path ?? "", { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }), {
				headers: ctx.altAuth?.() ?? {},
			})

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
			`a record belonging to another tenant was refused with ${existing.status}, while an id ` +
				`that does not exist was refused with ${absent.status}. The difference is an oracle: ` +
				"anyone able to guess or enumerate identifiers can learn which ones are real without " +
				"ever reading one. Both cases must answer identically — conventionally 404.",
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
			return ctx.findings.unresolved(this.id, ctx.entityName, "the create operation declares no request body to replay")
		}

		const body = validBody(ctx, schema)
		const key = `oat-idem-${ctx.seed}-${ctx.entityName}`
		const path = fillPath(createOp.path, ctx.scope)
		const headers = { ...ctx.auth(), [header]: key }

		const encoded = await encodeOpBody(ctx, createOp, body)
		const first = await ctx.client.request("POST", path, { ...encoded, headers })
		if (standDownForFeatureGate(ctx, createOp, first, this.id)) return
		if (first.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the first create returned ${first.status}, so there was nothing to replay`,
			)
		}
		const second = await ctx.client.request("POST", path, { ...encoded, headers })
		if (standDownForFeatureGate(ctx, createOp, second, this.id)) return
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
			`two identical POSTs carrying ${header}: "${key}" produced ${ctx.entityName} ${firstId} ` +
				`and ${secondId}. The header is declared, so clients will retry on timeouts assuming ` +
				"it protects them; every such retry silently duplicates the record.",
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
		ctx.createOp !== undefined &&
		ctx.createOp.invalidates.some((route) => ctx.model.byRoute.get(route)?.entity !== ctx.entityName),
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
				"the create operation declares no request body, so no write can be made",
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
			...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, created, this.id)) return
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
				`creating a ${ctx.entityName} declares x-invalidate on "${probe.op.route}", but that ` +
					"route returned a byte-identical body before and after the write. Either it serves " +
					"a value derived from this entity and that value is stale — a denormalised counter " +
					"or a cached projection nobody refreshed — or the declaration is wrong and every " +
					"client following it is invalidating the wrong cache key.",
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
		"select.requested-fields-present",
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
		if (field === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no field is filterable, sortable and non-null on the sample record, so no single fact " +
					"can be traced through every projection",
			)
		}

		const limit = ctx.query?.maxLimit ?? 100
		const seen: Array<{ projection: string; value: unknown }> = []
		const record = (result: ListResult): Record_ | undefined =>
			result.items.find((item) => String(item[ctx.identity]) === id)

		const detail = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
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
		const value = (detail.responseBody as Record_)[field]
		const rendered = String(value)

		const plain = await list(ctx, q(ctx, { limit }))
		const inList = record(plain)
		if (inList !== undefined) seen.push({ projection: "collection", value: inList[field] })

		const conventions = conv(ctx)
		if (conventions.select !== undefined) {
			const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
			const projected = projection === null ? null : await list(ctx, { ...q(ctx, { limit }), ...projection })
			const row = projected === null ? undefined : record(projected)
			if (row !== undefined) seen.push({ projection: "sparse fieldset", value: row[field] })
		}

		if (conventions.order !== undefined) {
			const sorted = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
			const row = record(sorted)
			if (row !== undefined) seen.push({ projection: "sorted page", value: row[field] })
		}

		const disagreeing = seen.filter((entry) => JSON.stringify(entry.value) !== JSON.stringify(value))
		if (disagreeing.length > 0) {
			ctx.findings.backend(
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
			`${ctx.entityName} ${id} carries "${field}" = ${JSON.stringify(value)} on every read path, ` +
				`yet filtering for exactly that value does not return it. The record and the predicate ` +
				"agree; the index or query that answers the filter does not.",
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
		filterable(ctx) && conv(ctx).order !== undefined && ctx.records.length > 2 && (ctx.query?.sortable.length ?? 0) > 0,
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
				"no filterable field holds a value shared by several records but not all of them, so " +
					"no filter can select a proper subset to reorder",
			)
		}

		const sortField =
			(ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity) ?? ctx.identity
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
		const both = await collectSet(ctx, limit, term, MAX_WALK_PAGES, sortTerm(conventions, sortField, "desc"))
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
				"the filtered set is larger than the walk covers, so the two runs cannot be compared " + "as whole sets",
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
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
				`order=${sortField} desc matched ${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Appeared: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"Ordering must reorder a result, never change its membership — a filter that only " +
				"holds while unsorted is one an index or query plan is silently dropping.",
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
		const walkOrder = tiebreak === undefined ? undefined : sortTerm(conventions, tiebreak, "asc")
		const probe = await list(ctx, q(ctx, { limit: 1, order: walkOrder }))
		const reported = envelopeValue(ctx, probe, "total")
		const pages = pagesToCover(typeof reported === "number" ? reported : undefined, pageSize)
		const everything = await collectSet(ctx, pageSize, {}, pages, walkOrder)
		const serverSide = await collectSet(ctx, pageSize, term, pages, walkOrder)
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
			`walking the collection at ${pageSize} per page and filtering client-side on ` +
				`"${field}" = ${JSON.stringify(value)} finds ${clientSide.size} record(s); asking the ` +
				`backend for the same filter returns ${returned.size}. Never returned: ` +
				`${skipped.slice(0, 3).join(", ")}. The page window is being computed before the ` +
				"predicate is applied, so matching records fall outside it and are lost — page one " +
				"looks correct and later pages silently omit data.",
			[everything.last.exchange, serverSide.last.exchange],
		)
	},
}

/**
 * A filter and a sparse fieldset must compose: projecting columns must never change which
 * records match.
 *
 * The failure this catches is a query builder that projects first and then cannot apply a
 * predicate to a column it just omitted, or that takes a different path the moment `fields=` is
 * present and forgets the WHERE. Each axis is correct alone — the filter returns the right set,
 * the select returns the right columns — and together the filter silently vanishes.
 *
 * The oracle is the same compositional property as {@link queryAxesCompose}: the filter alone
 * and the same filter with a select must return the same **set**. Identity is always requested
 * so the two sides remain comparable.
 */
const filterAndSelectCompose: Check = {
	applicable: (ctx) => filterable(ctx) && conv(ctx).select !== undefined && ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		/* If select is accepted and ignored, both sides still carry every column and the
		 * membership comparison remains well-defined — but a backend that has stopped honouring
		 * select at all may also have stopped taking the code path this check is probing. */
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-and-select-compose",
	needs: "a filterable field, a select parameter, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100

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
				"no filterable field holds a value shared by several records but not all of them, so " +
					"no filter can select a proper subset to project",
			)
		}

		const extra = (ctx.query?.selectable ?? []).find((name) => name !== ctx.identity) ?? ctx.identity
		const projection = selectTerm(conventions, [ctx.identity, extra], ctx.entityName)
		if (projection === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"this API's select grammar cannot express a sparse fieldset",
			)
		}

		const term = filterTerm(conventions, field, "eq", String(target[field]))
		if (term === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`this API's filter grammar cannot express equality on "${field}"`,
			)
		}

		const filtered = await collectSet(ctx, limit, term)
		const both = await collectSet(ctx, limit, { ...term, ...projection })
		if (filtered === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a select was rejected, so the two cannot be compared",
			)
		}
		if (!filtered.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered set is larger than the walk covers, so the two runs cannot be compared " + "as whole sets",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(both.items, ctx.identity))
		/* A projection that omitted the identity makes membership unobservable — that is a
		 * missing column, not a changed set, and select.projection-honoured already owns it. */
		if (both.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}
		const missing = [...alone].filter((id) => !combined.has(id))
		const extraIds = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extraIds.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a select changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
				`select=${[ctx.identity, extra].join(",")} matched ${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A projection must change which columns come back, never which rows — a filter " +
				"that only holds while every column is selected is one a query plan is dropping " +
				"once it has to name the columns.",
			[filtered.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A structured filter and a free-text search must compose as their intersection.
 *
 * Adding `q` often switches a backend onto a search-index path that does not honour the
 * structured predicate — or the reverse: a filter makes the search term a no-op. Each axis is
 * correct alone; together one of them vanishes. The oracle needs no ground truth: walk each
 * axis, walk both, and the combined set must equal the intersection.
 *
 * The two sides have to overlap without nesting. If the search matches only records the filter
 * already selected, dropping the filter is invisible — the combined set still equals the
 * intersection. The token is chosen so each axis matches something the other does not.
 */
const searchAndFilterCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		conv(ctx).search !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"pagination.page-walk-covers-set",
	],
	id: "query.search-and-filter-compose",
	needs: "a filterable field, a free-text search parameter, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100

		/*
		 * The first proper-subset filter is not always the one that overlaps a search. A status
		 * enum that happens to put both "alphabetically" records outside the chosen bucket makes
		 * every token nested, and dropping the filter becomes invisible. Walk every candidate
		 * until one overlaps without nesting.
		 */
		let field: string | undefined
		let target: Record_ | undefined
		let token: string | null = null
		for (const candidate of ctx.query?.filterable ?? []) {
			if (candidate === ctx.identity) continue
			const groups = new Map<string, Record_[]>()
			for (const record of ctx.records) {
				if (record[candidate] === null || record[candidate] === undefined) continue
				const key = JSON.stringify(record[candidate])
				const group = groups.get(key) ?? []
				group.push(record)
				groups.set(key, group)
			}
			for (const group of groups.values()) {
				if (group.length <= 1 || group.length >= ctx.records.length) continue
				const sample = group[0]
				if (sample === undefined) continue
				const guessed = new Set(ids(group, ctx.identity))
				const found = overlappingSearchToken(ctx, guessed)
				if (found === null) continue
				field = candidate
				target = sample
				token = found
				break
			}
			if (token !== null) break
		}
		if (field === undefined || target === undefined || token === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field and search token overlap without nesting, so dropping either " + "axis would be invisible",
			)
		}

		const term = filterTerm(conventions, field, "eq", String(target[field]))
		if (term === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`this API's filter grammar cannot express equality on "${field}"`,
			)
		}

		const filtered = await collectSet(ctx, limit, term)
		if (filtered === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered listing was rejected, so it cannot be compared with a search",
			)
		}
		if (!filtered.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered set is larger than the walk covers")
		}

		const filterIds = new Set(ids(filtered.items, ctx.identity))
		const searched = await collectSet(ctx, limit, q(ctx, { search: token }) as Record<string, string>)
		const both = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		if (searched === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a search was rejected, so the two cannot be compared",
			)
		}
		if (!searched.complete || !both.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const searchIds = new Set(ids(searched.items, ctx.identity))
		const expected = new Set([...filterIds].filter((id) => searchIds.has(id)))
		const got = new Set(ids(both.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a filter and a search do not compose as their intersection",
			`filter on "${field}" matched ${filterIds.size}; q=${JSON.stringify(token)} matched ` +
				`${searchIds.size}; both together matched ${got.size} (intersection is ` +
				`${expected.size}). ` +
				(missing.length > 0 ? `Missing: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Extra: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A structured predicate and a free-text search must narrow each other. When they " +
				"do not, one of them is being dropped the moment the other is present.",
			[filtered.last.exchange, searched.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A filter, a sort and a select must compose: adding both extra axes must not change which
 * records the filter matches.
 *
 * Pairwise composition is not enough. A planner that has a working two-axis path and a
 * broken three-axis path — the moment `order` and `fields` are both present, the WHERE is
 * dropped — passes every pair check. The oracle is the same membership property as the
 * pairs: the filter alone and the filter with both extras must return the same set.
 */
const filterSortSelectCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		conv(ctx).order !== undefined &&
		conv(ctx).select !== undefined &&
		(ctx.query?.sortable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
		/* Each pair has to hold before "the triple disagrees" means anything. A pair defect
		 * would also break this request, and reporting it again would name the wrong cause. */
		"query.axes-compose",
		"query.filter-and-select-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-sort-select-compose",
	needs: "a filterable field, a sortable field, a select parameter, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100
		const picked = properSubsetFilter(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field holds a value shared by several records but not all of them",
			)
		}
		const { field, target } = picked
		const term = filterTerm(conventions, field, "eq", String(target[field]))
		const extra = (ctx.query?.selectable ?? []).find((name) => name !== ctx.identity) ?? ctx.identity
		const projection = selectTerm(conventions, [ctx.identity, extra], ctx.entityName)
		const sortField =
			(ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity) ?? ctx.identity
		if (term === null || projection === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"this API cannot express the filter, the sort or the select together",
			)
		}

		const filtered = await collectSet(ctx, limit, term)
		const triple = await collectSet(
			ctx,
			limit,
			{ ...term, ...projection },
			MAX_WALK_PAGES,
			sortTerm(conventions, sortField, "desc"),
		)
		if (filtered === null || triple === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort and a select was rejected",
			)
		}
		if (!filtered.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (triple.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(triple.items, ctx.identity))
		const missing = [...alone].filter((id) => !combined.has(id))
		const extraIds = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extraIds.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort and a select together changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size}; the same filter with ` +
				`order=${sortField} desc and select=${[ctx.identity, extra].join(",")} matched ` +
				`${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"Each pair composes; the triple must too. A filter that only holds until both a " +
				"sort and a projection are present is one a three-axis query plan is dropping.",
			[filtered.last.exchange, triple.last.exchange],
		)
	},
}

/**
 * A filter, a search and a sort must compose: the intersection of filter and search must not
 * change when a sort is added.
 *
 * The search-index path that also tries to honour an ORDER BY is a common place to drop the
 * structured predicate. Pairwise, filter+search and filter+sort both hold; together they do not.
 */
const filterSearchSortCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		conv(ctx).search !== undefined &&
		conv(ctx).order !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		(ctx.query?.sortable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"sort.order-is-applied",
		"pagination.page-walk-covers-set",
		"query.search-and-filter-compose",
		"query.axes-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-search-sort-compose",
	needs: "a filterable field, a search parameter, a sortable field, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100
		const picked = overlappingFilterAndSearch(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field and search token overlap without nesting",
			)
		}
		const { field, target, token } = picked
		const term = filterTerm(conventions, field, "eq", String(target[field]))
		if (term === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`this API's filter grammar cannot express equality on "${field}"`,
			)
		}
		const sortField =
			(ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity) ?? ctx.identity
		const pair = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		const triple = await collectSet(
			ctx,
			limit,
			{ ...term, ...q(ctx, { search: token }) } as Record<string, string>,
			MAX_WALK_PAGES,
			sortTerm(conventions, sortField, "desc"),
		)
		if (pair === null || triple === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "combining a filter, a search and a sort was rejected")
		}
		if (!pair.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const expected = new Set(ids(pair.items, ctx.identity))
		const got = new Set(ids(triple.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter and a search return",
			`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
				`the same request with order=${sortField} desc matched ${got.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A sort must reorder the intersection, never change it.",
			[pair.last.exchange, triple.last.exchange],
		)
	},
}

/**
 * A filter, a search and a select must compose: projecting columns must not change the
 * intersection of filter and search.
 */
const filterSearchSelectCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		conv(ctx).search !== undefined &&
		conv(ctx).select !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
		"query.search-and-filter-compose",
		"query.filter-and-select-compose",
	],
	id: "query.filter-search-select-compose",
	needs: "a filterable field, a search parameter, a select parameter, and more than two records",
	async run(ctx) {
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100
		const picked = overlappingFilterAndSearch(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no filterable field and search token overlap without nesting",
			)
		}
		const { field, target, token } = picked
		const term = filterTerm(conventions, field, "eq", String(target[field]))
		const extra = (ctx.query?.selectable ?? []).find((name) => name !== ctx.identity) ?? ctx.identity
		const projection = selectTerm(conventions, [ctx.identity, extra], ctx.entityName)
		if (term === null || projection === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"this API cannot express the filter, the search or the select together",
			)
		}
		const pair = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		const triple = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
			...projection,
		} as Record<string, string>)
		if (pair === null || triple === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "combining a filter, a search and a select was rejected")
		}
		if (!pair.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (triple.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}

		const expected = new Set(ids(pair.items, ctx.identity))
		const got = new Set(ids(triple.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a select changes which records a filter and a search return",
			`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
				`the same request with select=${[ctx.identity, extra].join(",")} matched ${got.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A projection must change columns, never the intersection a filter and a search " +
				"already agreed on.",
			[pair.last.exchange, triple.last.exchange],
		)
	},
}

/** A filterable field whose value selects a proper subset of the cohort. */
function properSubsetFilter(ctx: CheckContext): { field: string; target: Record_ } | null {
	for (const candidate of ctx.query?.filterable ?? []) {
		if (candidate === ctx.identity) continue
		const values = ctx.records.map((record) => JSON.stringify(record[candidate]))
		const match = ctx.records.find((record) => {
			if (record[candidate] === null || record[candidate] === undefined) return false
			const count = values.filter((v) => v === JSON.stringify(record[candidate])).length
			return count > 1 && count < ctx.records.length
		})
		if (match !== undefined) return { field: candidate, target: match }
	}
	return null
}

/**
 * A filter value and a search token that overlap without nesting, so dropping either axis
 * changes the intersection.
 */
function overlappingFilterAndSearch(ctx: CheckContext): { field: string; target: Record_; token: string } | null {
	for (const candidate of ctx.query?.filterable ?? []) {
		if (candidate === ctx.identity) continue
		const groups = new Map<string, Record_[]>()
		for (const record of ctx.records) {
			if (record[candidate] === null || record[candidate] === undefined) continue
			const key = JSON.stringify(record[candidate])
			const group = groups.get(key) ?? []
			group.push(record)
			groups.set(key, group)
		}
		for (const group of groups.values()) {
			if (group.length <= 1 || group.length >= ctx.records.length) continue
			const sample = group[0]
			if (sample === undefined) continue
			const found = overlappingSearchToken(ctx, new Set(ids(group, ctx.identity)))
			if (found === null) continue
			return { field: candidate, target: sample, token: found }
		}
	}
	return null
}

/**
 * A search token that overlaps a filtered set without nesting — each side matches something
 * the other does not, so dropping either axis changes the intersection.
 */
function overlappingSearchToken(ctx: CheckContext, filterIds: Set<string>): string | null {
	const fields = ctx.query?.searchable ?? []
	if (fields.length === 0) return null

	const matches = (token: string): Set<string> => {
		const needle = token.toLowerCase()
		const hit = new Set<string>()
		for (const record of ctx.records) {
			if (
				fields.some((field) =>
					String(record[field] ?? "")
						.toLowerCase()
						.includes(needle),
				)
			) {
				hit.add(String(record[ctx.identity]))
			}
		}
		return hit
	}

	const candidates: string[] = []
	for (const record of ctx.records) {
		for (const name of fields) {
			const value = record[name]
			if (typeof value !== "string" || value.length < 2) continue
			candidates.push(value)
			if (value.length >= 3) candidates.push(value.slice(0, 3))
			for (const word of value.split(/\s+/)) {
				if (word.length >= 2) candidates.push(word)
			}
		}
	}

	for (const token of candidates) {
		const searchIds = matches(token)
		const inter = [...searchIds].filter((id) => filterIds.has(id)).length
		const onlySearch = [...searchIds].filter((id) => !filterIds.has(id)).length
		const onlyFilter = [...filterIds].filter((id) => !searchIds.has(id)).length
		if (inter > 0 && onlySearch > 0 && onlyFilter > 0) return token
	}
	return null
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
		conv(ctx).filter !== undefined &&
		ctx.query?.source === "tag" &&
		(ctx.query?.filterable.length ?? 0) > 0 &&
		ctx.records.length > 0,
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
			/* A declared field that never appears on the cohort is still a promise — often the
			 * most expensive kind, a column the document invented. Probe it with a sentinel. */
			const sample = ctx.records.find((record) => record[field] != null)
			const term = filterTerm(
				conventions,
				field,
				"eq",
				sample === undefined ? "oat-declared-field" : String(sample[field]),
			)
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
			`x-query lists ${rejected.length} field(s) as filterable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a filter that fails at runtime. " +
				"Either the column needs an index or the declaration needs removing — but the " +
				"document and the backend currently disagree about what this API can do.",
			[],
		)
	},
}

/**
 * The sort analogue of {@link declaredFilterableWorks}: `x-query.sortable` is a promise too, and
 * an `order` value the backend rejects breaks every client generated from the document exactly
 * the same way a rejected filter does.
 */
const declaredSortableWorks: Check = {
	applicable: (ctx) =>
		conv(ctx).order !== undefined &&
		ctx.query?.source === "tag" &&
		(ctx.query?.sortable.length ?? 0) > 0 &&
		ctx.records.length > 0,
	dependsOn: [
		"list.read-after-write",
		/* ERROR_500_ON_BAD_FILTER, despite its name, turns *any* SqlError the reference throws
		 * into a 500 — including a rejected `order` field, not just a malformed filter. Without
		 * this dependency a rejection lands outside the 4xx window this check looks for and the
		 * overclaim goes unreported: the same "SILENT" failure error.malformed-filter-not-5xx
		 * exists to catch, just reached from the sort path instead of the filter path. */
		"error.malformed-filter-not-5xx",
		/* Found by the fuzzer, not the matrix: on the SQL stores, ORDER_IGNORED short-circuits
		 * before the sortable whitelist is even consulted (the field-rejection check sits *after*
		 * the ignore-order early return), so a backend that has stopped applying `order` at all
		 * also stops rejecting an overclaimed field — the request simply succeeds with the default
		 * order. The overclaim is real but unobservable until ordering itself works again. */
		"sort.order-is-applied",
	],
	id: "spec.declared-sortable-is-sortable",
	needs: "x-query naming sortable fields",
	async run(ctx) {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number }> = []
		let probed = 0

		for (const field of ctx.query?.sortable ?? []) {
			probed += 1
			const result = await list(ctx, q(ctx, { limit: 5, order: sortTerm(conventions, field, "asc") }))
			/* Only a rejection counts. Order accepted but not applied is sort.order-is-applied's
			 * finding, not a capability claim breaking. */
			if (result.exchange.status >= 400 && result.exchange.status < 500) {
				rejected.push({ field, status: result.exchange.status })
			}
		}

		if (probed === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no declared sortable field could be probed")
		}
		if (rejected.length === 0) return

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a sort field the backend does not accept",
			`x-query lists ${rejected.length} field(s) as sortable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer an order value that fails at " +
				"runtime. Either the column needs an index or the declaration needs removing — but " +
				"the document and the backend currently disagree about what this API can do.",
			[],
		)
	},
}

/**
 * The select analogue of {@link declaredFilterableWorks} and {@link declaredSortableWorks}:
 * `x-query.selectable` is a promise too, and a sparse fieldset the backend rejects breaks every
 * client generated from the document exactly the same way a rejected filter or sort does.
 */
const declaredSelectableWorks: Check = {
	applicable: (ctx) =>
		conv(ctx).select !== undefined &&
		ctx.query?.source === "tag" &&
		(ctx.query?.selectable.length ?? 0) > 0 &&
		ctx.records.length > 0,
	dependsOn: [
		"list.read-after-write",
		/* Same masking risk as the filter and sort overclaim checks: ERROR_500_ON_BAD_FILTER turns
		 * any rejection — this one included — into a 500, which would fall outside the 4xx window
		 * below and read as accepted. */
		"error.malformed-filter-not-5xx",
		/* Same shape as the sort check's dependency on sort.order-is-applied, found by inspection
		 * before the fuzzer had to: `project()` returns the row untouched under SELECT_IGNORED
		 * *before* the excluded-field check runs, so a backend that has stopped honouring `select`
		 * at all also stops rejecting an overclaimed field — the request just returns every column. */
		"select.projection-honoured",
	],
	id: "spec.declared-selectable-is-selectable",
	needs: "x-query naming selectable fields",
	async run(ctx) {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number }> = []
		let probed = 0

		for (const field of ctx.query?.selectable ?? []) {
			const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
			if (projection === null) continue
			probed += 1
			const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
			/* Only a rejection counts. A field accepted and then ignored is select.projection-
			 * honoured's finding, not a capability claim breaking. */
			if (result.exchange.status >= 400 && result.exchange.status < 500) {
				rejected.push({ field, status: result.exchange.status })
			}
		}

		if (probed === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no declared selectable field could be probed")
		}
		if (rejected.length === 0) return

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a select field the backend does not accept",
			`x-query lists ${rejected.length} field(s) as selectable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a sparse fieldset that fails at " +
				"runtime. Either the field needs to stay projectable or the declaration needs " +
				"removing — but the document and the backend currently disagree about what this API " +
				"can do.",
			[],
		)
	},
}

const crossTenantItemRead: Check = {
	applicable: (ctx) =>
		ctx.altAuth !== undefined && ctx.readOp !== undefined && ctx.records.length > 0 && tenantBoundary(ctx.readOp),
	id: "tenant.item-not-readable-cross-tenant",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
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
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
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
		ctx.records.length > 0 &&
		tenantBoundary(ctx.listOp),
	/* The probe filters, so anything that stops a filter from selecting over the whole collection
	 * hides the very record whose visibility is in question — a leak that cannot be observed is
	 * not a leak that can be reported. */
	dependsOn: ["query.filter-selects-from-whole-set"],
	id: "tenant.filter-does-not-bypass-scope",
	needs: "a second principal, a filter, and a tenant tagged or inferred from the path",
	async run(ctx) {
		const target = ctx.records[0]
		if (target === undefined || ctx.altAuth === undefined || ctx.altScope === undefined) return
		if (!identityIsFilterable(ctx)) return
		const id = String(target[ctx.identity])

		const tenantTerm = filterTerm(conv(ctx), filterIdentity(ctx), "eq", id)
		if (tenantTerm === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...tenantTerm }, ctx.altAuth, ctx.altScope)
		if (result.exchange.status >= 400) return
		if (!ids(result.items, ctx.identity).includes(id)) return

		/* Same split as the item check. A public catalogue has no tenant at all — a 200 for
		 * `id.eq.<someone else's public row>` is the contract, not a leak. */
		const declared = ctx.listOp.tenantSource === "tag"
		const detail =
			`a principal in another tenant filtered on ${ctx.identity}.eq.${id} and received the ` +
			"record. The tenant predicate is applied to the base listing but not re-applied to " +
			"filter matches, so any caller who can guess an id can read it."

		if (declared) {
			ctx.findings.security(
				this.id,
				ctx.entityName,
				"a filter reaches records outside the caller's tenant",
				`${detail} The list declares x-tenant: "${ctx.listOp.tenantParam}", so this crosses ` +
					"a boundary the document states exists.",
				[result.exchange],
			)
			return
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${ctx.listOp.tenantParam}" path ` +
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
			entity: ctx.entityName,
			evidence: [result.exchange],
			summary: "a filter crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
	},
}

function sameTenantScope(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
	if (keys.length === 0) return true
	return keys.every((key) => a[key] === b[key])
}

/**
 * Privilege must be monotonic in rank: anything a lower-ranked role can do, a higher-ranked
 * role in the same tenant must also be able to do.
 *
 * The oracle needs no ground truth about what "owner" means. Two principals, same tenant,
 * different ranks, one item. If the lower one is served and the higher one is denied, the
 * lattice is upside down — the failure mode of every hand-rolled role table that inverted
 * a comparison or attached the wrong policy to a name.
 */
const rankIsMonotonic: Check = {
	applicable: (ctx) => {
		if (ctx.readOp === undefined || ctx.records.length === 0) return false
		const primary = ctx.actors[0]
		if (primary === undefined) return false
		const home = ctx.actors.filter((actor) => sameTenantScope(actor.roots, primary.roots))
		return new Set(home.map((actor) => actor.rank)).size >= 2
	},
	dependsOn: ["list.read-after-write"],
	id: "auth.rank-is-monotonic",
	needs: "two same-tenant principals at different ranks, and an item route",
	async run(ctx) {
		const target = ctx.records[0]
		const primary = ctx.actors[0]
		if (target === undefined || ctx.readOp === undefined || primary === undefined) return
		const id = String(target[ctx.identity])
		const home = ctx.actors.filter((actor) => sameTenantScope(actor.roots, primary.roots))

		const readOp = ctx.readOp
		const probe = async (actor: Actor): Promise<"allow" | "deny" | "error"> => {
			/* Tenant from the actor; remaining path params (parent ids) from the seeded scope. */
			const params = { ...ctx.scope, ...actor.roots, ...itemParamFor(ctx, id) }
			const exchange = await ctx.client.get(fillPath(readOp.path, params), {
				headers: actor.headers(),
			})
			if (exchange.status < 300) return "allow"
			if (exchange.status === 403 || exchange.status === 404) return "deny"
			return "error"
		}

		const outcomes = new Map<string, "allow" | "deny" | "error">()
		for (const actor of home) {
			outcomes.set(actor.id, await probe(actor))
		}

		for (const lower of home) {
			for (const higher of home) {
				if (lower.rank >= higher.rank) continue
				const lo = outcomes.get(lower.id)
				const hi = outcomes.get(higher.id)
				if (lo !== "allow" || hi !== "deny") continue
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a lower-ranked role can read a record a higher-ranked role cannot",
					`${lower.role ?? lower.id} (rank ${lower.rank}) was served ${ctx.entityName} ${id}; ` +
						`${higher.role ?? higher.id} (rank ${higher.rank}) was denied. Privilege must be ` +
						"monotonic — a member who can see what an owner cannot is the lattice inverted, " +
						"not a finer policy.",
					[],
				)
				return
			}
		}
	},
}

function pointerValue(body: unknown, pointer: string): string | undefined {
	const path = pointer
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)
	let node: unknown = body
	for (const segment of path) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return typeof node === "string" && node !== "" ? node : undefined
}

/**
 * Delegated access is a flow, not a request: B cannot read A's record, A invites B, B accepts,
 * B can read, A revokes, B cannot. Each step is a capability statement the next one depends on.
 * A grant that appears before accept, never appears, or survives revoke is a different bug
 * at the same check — the timeline is the property.
 */
const inviteGrantsThenRevokes: Check = {
	applicable: (ctx) => ctx.invite !== null && (ctx.readOp !== undefined || ctx.listOp !== undefined),
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "auth.invite-grants-then-revokes",
	needs: "x-invite naming invite/accept/revoke, a peer principal with inviteAs, and an item or list route",
	async run(ctx) {
		const spec = ctx.invite
		const owner = ctx.actors[0]
		if (spec === null || owner === undefined) {
			return
		}
		const delegate =
			ctx.actors.find(
				(actor) => actor !== owner && actor.inviteAs !== undefined && !sameTenantScope(actor.roots, owner.roots),
			) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
		if (delegate === undefined || delegate.inviteAs === undefined) {
			return ctx.findings.gap(
				this.id,
				ctx.entityName,
				"x-invite requires a peer principal with inviteAs",
				"x-invite names the grant flow, but no peer principal declares inviteAs, so oat " +
					"cannot fill the grantee field without inventing an email",
			)
		}
		const inviteOp = ctx.model.byOperationId.get(spec.invite)
		const acceptOp = ctx.model.byOperationId.get(spec.accept)
		const revokeOp = ctx.model.byOperationId.get(spec.revoke)
		if (inviteOp === undefined || acceptOp === undefined || revokeOp === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "x-invite names an operation that is not in the document")
		}

		const target = ctx.records[0]
		const id = target === undefined ? undefined : String(target[ctx.identity])
		const resource = {
			...ctx.scope,
			...(id === undefined ? {} : itemParamFor(ctx, id)),
		}

		const itemPath = ctx.readOp?.path
		const canRead = async (): Promise<boolean | null> => {
			if (itemPath === undefined || id === undefined) return null
			const exchange = await ctx.client.get(fillPath(itemPath, { ...delegate.roots, ...resource }), {
				headers: delegate.headers(),
			})
			return exchange.status < 300
		}

		const alreadyReadable = await canRead()
		if (alreadyReadable === true) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the delegate could already read the record, so invite cannot be distinguished from a leak",
			)
		}

		const invited = await ctx.client.request(inviteOp.method, fillPath(inviteOp.path, resource), {
			body: { [spec.granteeField]: delegate.inviteAs },
			headers: { ...owner.headers(), "content-type": "application/json" },
			operationId: inviteOp.operationId,
		})
		if (standDownForFeatureGate(ctx, inviteOp, invited, this.id)) return
		if (invited.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`invite returned ${invited.status}, so accept/revoke were never exercised`,
			)
		}
		if ((await canRead()) === true) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an invite grants access before it is accepted",
				`inviting ${delegate.id} made ${ctx.entityName} ${id} readable immediately. The accept ` +
					"step is then theatre — anyone who can be named in an invite body is already in.",
				[invited],
			)
			return
		}

		const grantId = pointerValue(invited.responseBody, spec.grantPointer)
		let token: string | undefined
		if (spec.tokenFrom === "outOfBand") {
			const kind = spec.tokenKind ?? `${ctx.entityName}-invite`
			try {
				token = await resolveOutOfBandValue(ctx.hooks.resolveOutOfBand, delegate.inviteAs, kind, {
					label: `invite to ${ctx.entityName}`,
					outOfBand: ctx.outOfBand,
				})
			} catch (error) {
				return ctx.findings.unresolved(this.id, ctx.entityName, error instanceof Error ? error.message : String(error))
			}
		} else {
			token = pointerValue(invited.responseBody, spec.tokenPointer)
			if (token === undefined) {
				return ctx.findings.unresolved(this.id, ctx.entityName, `invite response has no token at ${spec.tokenPointer}`)
			}
		}

		const acceptScope = { ...resource, token }
		const acceptBody = documentedJsonBody(ctx, acceptOp, acceptScope)
		const accepted = await ctx.client.request(acceptOp.method, fillPath(acceptOp.path, acceptScope), {
			...(acceptBody === undefined ? {} : { body: acceptBody }),
			headers: {
				...delegate.headers(),
				...(acceptBody === undefined ? {} : { "content-type": "application/json" }),
			},
			operationId: acceptOp.operationId,
		})
		if (standDownForFeatureGate(ctx, acceptOp, accepted, this.id)) return
		if (accepted.status >= 300) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `accept returned ${accepted.status}`)
		}
		if ((await canRead()) === false) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"accepting an invite does not grant access",
				`${delegate.id} accepted an invite to ${ctx.entityName} ${id} and still cannot read it. ` +
					"The invite flow completed; the grant did not.",
				[invited, accepted],
			)
			return
		}

		if (grantId === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`invite response has no grant id at ${spec.grantPointer}, so revoke cannot be expressed`,
			)
		}
		const revokeScope = { ...resource, grant_id: grantId, token }
		const revokeBody = documentedJsonBody(ctx, revokeOp, revokeScope)
		const revoked = await ctx.client.request(revokeOp.method, fillPath(revokeOp.path, revokeScope), {
			...(revokeBody === undefined ? {} : { body: revokeBody }),
			headers: {
				...owner.headers(),
				...(revokeBody === undefined ? {} : { "content-type": "application/json" }),
			},
			operationId: revokeOp.operationId,
		})
		if (standDownForFeatureGate(ctx, revokeOp, revoked, this.id)) return
		if (revoked.status >= 300) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `revoke returned ${revoked.status}`)
		}
		if ((await canRead()) === true) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"revoking an invite does not remove access",
				`${delegate.id} can still read ${ctx.entityName} ${id} after the grant was revoked. ` +
					"A share that cannot be taken back is a standing leak.",
				[invited, accepted, revoked],
			)
		}
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
				`${values
					.slice(0, 5)
					.map((v) => JSON.stringify(v))
					.join(", ")}. A sort parameter the ` +
				"backend ignores silently gives every caller arbitrary ordering.",
			[ascending.exchange],
		)
	},
}

function numericLexicalDisagrees(ctx: CheckContext, field: string): boolean {
	const values = ctx.records.map((row) => row[field]).filter((v): v is number => typeof v === "number")
	if (values.length < 3) return false
	const unique = [...new Set(values)]
	const asNumbers = [...unique].sort((a, b) => a - b)
	const asText = [...unique].sort((a, b) => String(a).localeCompare(String(b)))
	return asNumbers.join(",") !== asText.join(",")
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
		conv(ctx).search !== undefined && (ctx.query?.searchable.length ?? 0) > 0 && ctx.records.length > 2,
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
		const request = submittedFields(sent.requestBody)
		if (Object.keys(request).length === 0) return
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
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id)) return
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
		const target = findConstrained(schema, (s) => typeof s.maxLength === "number" && (s.maxLength as number) < 4096)
		if (target === null) return
		const max = target.schema.maxLength as number

		const body = { ...validBody(ctx, schema), [target.name]: "x".repeat(max + 25) }
		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id)) return
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
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id)) return
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
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id)) return
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
		if (exchange.status >= 400 && validator.documents(raw, exchange.status)) {
			const result = validator.validate(readOp.operationId, raw, exchange.status, exchange.responseBody)
			if (!result.ok) {
				ctx.findings.spec(
					this.id,
					ctx.entityName,
					`${exchange.status} error body does not match its documented schema`,
					`${readOp.operationId} returned ${exchange.status} with a body that fails the schema the ` +
						`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
						"from the spec will not understand this response.",
					[exchange],
				)
			}
		}

		/* A documented feature-gate 403 is coverage for the 2xx check, not for the error schema.
		 * Walk this entity's already-observed gate denials so an undeclared body is still drift. */
		const seen = new Set<string>()
		for (const op of ctx.model.operations) {
			if (op.entity !== ctx.entityName || op.featureGate === null) continue
			const opRaw = ctx.model.rawOperations.get(op.operationId)
			if (opRaw === undefined) continue
			for (const prior of ctx.client.transcript) {
				if (!isDocumentedFeatureGateDenial(op, prior.status, prior.responseBody)) continue
				const key = `${op.operationId}:${prior.seq}`
				if (seen.has(key)) continue
				seen.add(key)
				reportFeatureGateSchemaDrift(ctx.findings, validator, op, opRaw, prior, ctx.entityName)
			}
		}
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
		if (isEventStream(exchange, createOp)) return
		if (!validator.documents(raw, exchange.status)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`create returned ${exchange.status}, which the document declares no schema for — ` +
					"there is nothing to validate the body against",
			)
		}

		const result = validator.validate(createOp.operationId, raw, exchange.status, exchange.responseBody)
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
	const [member] = buildCohort(schema, ctx.seed, ["baseline"], ctx.createOp?.operationId ?? ctx.entityName)
	return member?.body ?? {}
}

/** Invite bodies must carry the peer's `inviteAs`, never a generated email. */
function bodyForOp(ctx: CheckContext, op: OperationModel): Record<string, unknown> {
	const body = validBody(ctx, requestSchemaOf(ctx, op) ?? {})
	const spec = op.invite ?? ctx.invite
	if (spec === null || spec === undefined) return body
	const owner = ctx.actors[0]
	const delegate =
		ctx.actors.find(
			(actor) =>
				actor !== owner &&
				actor.inviteAs !== undefined &&
				owner !== undefined &&
				!sameTenantScope(actor.roots, owner.roots),
		) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
	if (delegate?.inviteAs !== undefined) body[spec.granteeField] = delegate.inviteAs
	return body
}

function subject(entity: string, operationId: string, fixture?: string): string {
	if (fixture === undefined) return entity
	return `${operationId} · ${fixture}`
}

function requestSchemaOf(ctx: CheckContext, op: OperationModel): Record<string, unknown> | null {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	return picked === null ? null : picked.schema
}

async function encodeOpBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, unknown>,
	variant = "baseline",
	index = 0,
	uploads: UploadContext = ctx.uploads,
): Promise<Pick<RequestOptions, "body" | "contentType">> {
	const encoded = await encodeForOperation(op, ctx.model, fields, uploads, variant, index)
	return encoded.contentType === undefined
		? { body: encoded.body }
		: { body: encoded.body, contentType: encoded.contentType }
}

function submittedFields(body: unknown): Record_ {
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const out: Record_ = {}
		for (const [name, value] of body.entries()) {
			if (typeof value === "string") out[name] = value
		}
		return out
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return Object.fromEntries(body.entries())
	}
	if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record_
	return {}
}

/** Document first, then the live `Content-Type`. Media type is the stream tag — not `x-async`. */
function isEventStream(exchange: Exchange, op?: OperationModel): boolean {
	if (op?.eventStream === true) return true
	const type = exchange.responseHeaders["content-type"] ?? ""
	return type.includes("text/event-stream")
}

/**
 * JSON request body declared on the operation, filled from known flow values.
 *
 * Path-only accept/revoke (`POST /invites/{token}` with no body) stay path-only.
 */
function documentedJsonBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, string>,
): Record<string, unknown> | undefined {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	if (picked === null || !picked.mediaType.includes("json")) return undefined
	const properties = picked.schema.properties
	if (properties !== null && typeof properties === "object") {
		const names = Object.keys(properties as object)
		if (names.length > 0) {
			const body: Record<string, unknown> = {}
			for (const name of names) {
				if (fields[name] !== undefined) body[name] = fields[name]
			}
			return body
		}
	}
	if (fields.token !== undefined) return { token: fields.token }
	if (fields.grant_id !== undefined) return { grant_id: fields.grant_id }
	return { ...fields }
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
					candidate !== null && typeof candidate === "object" && predicate(candidate as Record<string, unknown>),
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
 * An operation declaring `x-effects` must produce the stated change.
 *
 * `count` is an exact cardinality delta (default 1). `min` is at-least. After a `create` on A,
 * later items in the same array fill a child list under A with the new id — from the write
 * response (`table_id` or the entity identity) or from A's list delta.
 *
 * `x-invalidate` says a read route changes; `x-effects` says *how*. That difference is what
 * separates "something differed" — which is satisfied by a stray timestamp and missed by a
 * cache-stale read — from an assertion on cardinality and membership.
 */
/**
 * A numeric field must compare numerically, not lexically.
 *
 * Query values arrive from a URL as text, and a backend that forgets to coerce them compares
 * "10" < "9" — so `amount.gt.9` silently omits 10, 20 and 100. The result is a plausible-looking
 * subset rather than an error, which is why it survives in production.
 */
const numericComparisonIsNumeric: Check = {
	applicable: (ctx) => filterable(ctx) && numericFilterField(ctx) !== null && ctx.records.length > 2,
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected"],
	id: "filter.numeric-comparison-is-numeric",
	needs: "a `filter` parameter and a numeric field",
	async run(ctx) {
		const field = numericFilterField(ctx)
		if (field === null) return

		const values = ctx.records.map((r) => r[field]).filter((v): v is number => typeof v === "number")
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
		/* Extra matching rows outside the seeded cohort are not a defect. Score got ∩ known. */

		const gtTerm = filterTerm(conv(ctx), field, "gt", threshold)
		if (gtTerm === null) return
		const result = await list(ctx, { ...q(ctx, { limit: ctx.query?.maxLimit ?? 100 }), ...gtTerm })
		if (result.exchange.status >= 400) return
		const got = ids(result.items, ctx.identity)
		const gotKnown = [...knownHits(result.items, ctx)].sort()
		if (gotKnown.join(",") === expected.join(",")) return

		const missing = expected.filter((id) => !gotKnown.includes(id))
		const extra = gotKnown.filter((id) => !expected.includes(id))
		const lexical = expected.filter((id) => {
			const record = ctx.records.find((r) => String(r[ctx.identity]) === id)
			return record !== undefined && String(record[field]) < String(threshold)
		})
		const comparedAsText = missing.length > 0 && missing.every((id) => lexical.includes(id))

		ctx.findings.backend(
			this.id,
			ctx.entityName,
			comparedAsText
				? `"${field}" is compared as text rather than as a number`
				: `"${field}" comparison does not agree with numeric ordering`,
			`filter=${field}.gt.${threshold} returned ${got.length} record(s); ${expected.length} known ` +
				`records hold a greater numeric value. Missing: ${missing.slice(0, 4).join(", ") || "none"}. ` +
				`Unexpected: ${extra.slice(0, 4).join(", ") || "none"}. ` +
				(comparedAsText
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
	applicable: (ctx) => ctx.updateOp !== undefined && ctx.readOp !== undefined && ctx.records.length > 0,
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
				`reading the record back returned ${before.status}, so there was no baseline to race ` + "against",
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
				`only ${fields.length} writable string field(s) are present on the record; two are ` +
					"needed so the concurrent writes cannot legitimately clobber each other",
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
		if (standDownForFeatureGate(ctx, ctx.updateOp, firstWrite, this.id)) return
		if (standDownForFeatureGate(ctx, ctx.updateOp, secondWrite, this.id)) return
		if (standDownForRateLimit(ctx, firstWrite, this.id)) return
		if (standDownForRateLimit(ctx, secondWrite, this.id)) return
		if (firstWrite.status >= 300 || secondWrite.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a concurrent PATCH was rejected (${firstWrite.status}, ${secondWrite.status}), so no ` +
					"race actually took place",
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
			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const effects = op.effects
				if (effects.length === 0) return

				const scope = { ...ctx.scope }
				const befores = new Map<string, Observation>()

				for (const effect of effects) {
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) continue
					if (befores.has(effect.entity)) continue
					befores.set(effect.entity, await observe(ctx, listOp, scope))
				}

				const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
				const invoked = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					operationId: op.operationId,
					...(fixture === undefined ? {} : { fixture }),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, invoked, this.id)) return
				if (standDownForRateLimit(ctx, invoked, this.id)) return
				if (invoked.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be invoked`,
						`returned ${invoked.status}; its declared effects are unverified`,
						fixture,
					)
					return
				}

				const deltas = new Map<string, string[]>()
				Object.assign(scope, bindAfterCreateEffects(ctx.model, effects, invoked.responseBody, deltas))

				for (const effect of effects) {
					if (effect.op !== "create") continue
					const param = identityPathParam(ctx.model, effect.entity)
					if (scope[param] !== undefined) continue
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) continue
					const afterParent = await observe(ctx, listOp, scope)
					if (afterParent.status !== "ok") continue
					const before = befores.get(effect.entity)
					const prior = before?.status === "ok" ? before.ids : []
					const added = afterParent.ids.filter((id) => !prior.includes(id))
					deltas.set(effect.entity, added)
					Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, invoked.responseBody, added))
				}

				for (const effect of effects) {
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", which has no list route`,
							"the effect cannot be observed, so it is not verified",
							fixture,
						)
						continue
					}

					if (!canFillPath(listOp.path, scope)) {
						const missing = listOp.pathParams.filter((name) => scope[name] === undefined)
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", but the list path cannot be filled`,
							`missing ${missing.map((name) => `{${name}}`).join(", ")} after the write; the effect is unverified`,
							fixture,
						)
						continue
					}

					const after = await observe(ctx, listOp, scope)
					if (after.status === "error") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} could not observe "${effect.entity}" after the write`,
							`list returned ${after.exchange.status}; the declared effect is unverified`,
							fixture,
						)
						continue
					}
					if (after.status === "unfillable") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", but the list path cannot be filled`,
							"the child list still lacks a parent id after the write; the effect is unverified",
							fixture,
						)
						continue
					}

					const before = befores.get(effect.entity)
					if (before?.status === "error") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} could not observe "${effect.entity}" before the write`,
							`list returned ${before.exchange.status}; no baseline, so the effect is unverified`,
							fixture,
						)
						continue
					}
					const prior = before?.status === "ok" ? before.ids : []
					const delta = after.ids.length - prior.length
					const added = after.ids.filter((id) => !prior.includes(id))
					const removed = prior.filter((id) => !after.ids.includes(id))

					if (effectHolds(effect, delta, added.length, removed.length)) {
						if (effect.op === "create") {
							Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, invoked.responseBody, added))
						}
						continue
					}

					const hold = describeEffectHold(effect)
					if (effect.op === "create" || effect.op === "append") {
						ctx.findings.backend(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} did not produce the "${effect.entity}" records it declares`,
							`x-effects declares ${hold} on "${effect.entity}", but the ` +
								`collection went from ${prior.length} to ${after.ids.length} ` +
								`(${added.length} added, ${removed.length} removed). A declared effect that does ` +
								"not occur means callers cannot rely on the operation having done anything.",
							[invoked, after.exchange],
							fixture,
						)
						continue
					}

					if (effect.op === "delete") {
						ctx.findings.backend(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} did not remove the "${effect.entity}" records it declares`,
							`x-effects declares ${hold} on "${effect.entity}", but the collection ` +
								`went from ${prior.length} to ${after.ids.length}`,
							[invoked, after.exchange],
							fixture,
						)
						continue
					}

					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} changed the size of "${effect.entity}" while declaring ${effect.op}`,
						`x-effects declares ${effect.op}, which must not add or remove records, but the ` +
							`collection went from ${prior.length} to ${after.ids.length}`,
						[invoked, after.exchange],
						fixture,
					)
				}
			})
		}
	},
}

/**
 * After a write that declares `x-wait`, poll the named GET until a JSON path is occupied
 * (or `awaitSideEffect` returns true). Timeout is a backend finding, not a coverage gap.
 */
const sideEffectArrives: Check = {
	applicable: (ctx) => ctx.waitOps.length > 0,
	dependsOn: ["list.read-after-write"],
	mutates: true,
	id: "effects.side-effect-arrives",
	needs: "an operation declaring x-wait",
	async run(ctx) {
		for (const op of ctx.waitOps) {
			const spec = op.wait
			if (spec === null) continue
			const pollOp = ctx.model.byOperationId.get(spec.operationId)
			if (pollOp === undefined) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${op.operationId} x-wait names "${spec.operationId}", which is not in the document`,
					"the side effect cannot be observed, so it is not verified",
				)
				continue
			}

			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
				const invoked = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					operationId: op.operationId,
					...(fixture === undefined ? {} : { fixture }),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, invoked, this.id)) return
				if (standDownForRateLimit(ctx, invoked, this.id)) return
				if (invoked.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be invoked`,
						`returned ${invoked.status}; its declared x-wait is unverified`,
						fixture,
					)
					return
				}

				const scope = bindWaitScope(ctx, op, pollOp, invoked.responseBody)
				const outcome = await driveWait({
					awaitSideEffect: ctx.hooks.awaitSideEffect,
					client: ctx.client,
					headers: ctx.auth,
					pollOp,
					record: invoked.responseBody,
					scope,
					spec,
					writeOpId: op.operationId,
					...(ctx.refreshIfStale === undefined ? {} : { refreshIfStale: ctx.refreshIfStale }),
				})
				if (!outcome.timedOut) return
				ctx.findings.backend(
					this.id,
					subject(ctx.entityName, op.operationId, fixture),
					`${op.operationId} side effect did not appear within ${spec.timeoutMs}ms`,
					`x-wait polls ${spec.operationId}` +
						(spec.until === undefined ? "" : ` until ${spec.until} is non-empty`) +
						` and the path was still empty after ${outcome.polls} poll(s) / ${Math.round(outcome.elapsedMs)}ms. ` +
						"Queue consumers and webhook inboxes are not the same request; a timeout here is a " +
						"missed delivery, not a coverage gap.",
					[invoked, ...outcome.exchanges.slice(-2)],
					fixture,
				)
			})
		}
	},
}

type Observation =
	| { status: "unfillable" }
	| { status: "error"; exchange: Exchange }
	| { status: "ok"; ids: string[]; exchange: Exchange }

function listOpFor(ctx: CheckContext, entityName: string): OperationModel | undefined {
	const listId = ctx.model.entities.get(entityName)?.list
	return listId === undefined ? undefined : ctx.model.byOperationId.get(listId)
}

function bindWaitScope(
	ctx: CheckContext,
	writeOp: OperationModel,
	pollOp: OperationModel,
	writeBody: unknown,
): Record<string, string> {
	const scope = { ...ctx.scope }
	Object.assign(scope, bindAfterCreateEffects(ctx.model, writeOp.effects, writeBody))
	Object.assign(scope, bindMissingPathParams(pollOp.pathParams, scope, writeBody))
	return scope
}

async function observe(
	ctx: CheckContext,
	listOp: OperationModel,
	scope: Record<string, string> = ctx.scope,
): Promise<Observation> {
	let path: string
	try {
		path = fillPath(listOp.path, scope)
	} catch {
		return { status: "unfillable" }
	}
	const exchange = await ctx.client.get(path, {
		headers: ctx.auth(),
		operationId: listOp.operationId,
		query: { limit: listOp.query?.maxLimit ?? 100 },
	})
	if (exchange.status >= 400) return { exchange, status: "error" }
	const identity = ctx.model.entities.get(listOp.entity ?? "")?.identity ?? "id"
	const items = extractItems(exchange.responseBody, listOp.collection?.key ?? null)
	return { exchange, ids: items.map((item) => String(item[identity])), status: "ok" }
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

			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
				const start = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, start, this.id)) return
				if (start.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be started`,
						`returned ${start.status}; the async lifecycle after it is untested`,
						fixture,
					)
					return
				}

				const streamed = isEventStream(start, op)
				const fromStream = streamed ? inspectStreamAsync(start.responseBody, spec) : null
				if (fromStream?.terminal !== null && fromStream?.terminal !== undefined) {
					if (spec.successWhen !== undefined && !matchesPredicate(fromStream.terminal, spec.successWhen)) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} reached a non-success terminal state`,
							`terminal state did not satisfy "${spec.successWhen}"; downstream effects of ` +
								"this operation are untested",
							fixture,
						)
					}
					return
				}

				const receipt =
					fromStream?.idRecord !== null && fromStream?.idRecord !== undefined ? fromStream.idRecord : start.responseBody
				if (streamed && fromStream !== null && (fromStream.id === undefined || fromStream.id === null)) {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} job disappeared before completing`,
						"the stream ended without a terminal frame and without a job id, so the poll route cannot be named.",
						[start],
						fixture,
					)
					return
				}

				const outcome = await driveAsync(ctx.client, spec, receipt, ctx.scope, ctx.auth, ctx.refreshIfStale)

				if (outcome.timedOut) {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} never reached a terminal state`,
						`polled ${spec.poll} ${outcome.polls} time(s) over ${Math.round(outcome.elapsedMs)}ms ` +
							`without satisfying "${spec.until ?? "any terminal state"}". A job that neither ` +
							"completes nor fails leaves callers polling forever.",
						[start, ...outcome.exchanges.slice(-2)],
						fixture,
					)
					return
				}

				if (outcome.terminal === null) {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} job disappeared before completing`,
						`the poll route stopped serving the job after ${outcome.polls} poll(s). A job that ` +
							"vanishes is indistinguishable from one that never existed.",
						[start, ...outcome.exchanges.slice(-2)],
						fixture,
					)
					return
				}

				if (!outcome.succeeded) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} reached a non-success terminal state`,
						`terminal state did not satisfy "${spec.successWhen ?? ""}"; downstream effects of ` +
							"this operation are untested",
						fixture,
					)
				}
			})
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

			const node = resolveAsyncId(started.responseBody, spec.idFrom)
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

const ASCII_PAYLOAD_PROBE = "oat-payload-probe"

interface PayloadField {
	name: string
	maxLength: number | undefined
	minLength: number | undefined
}

function pickPayloadField(ctx: CheckContext, op: OperationModel): PayloadField | null {
	const schema = requestSchemaOf(ctx, op)
	const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
	const immutable = new Set([
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...(ctx.createOp?.generated ?? []),
		ctx.identity,
	])
	let best: (PayloadField & { score: number }) | null = null
	for (const [name, declared] of Object.entries(properties)) {
		if (immutable.has(name) || /_at$|_id$/.test(name)) continue
		if (declared === null || typeof declared !== "object") continue
		if (declared.readOnly === true) continue
		const union = declared.oneOf ?? declared.anyOf
		const branch = Array.isArray(union)
			? (union.find(
					(candidate) =>
						candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === "string",
				) as Record<string, unknown> | undefined)
			: undefined
		const stringSchema = branch ?? declared
		const type = stringSchema.type
		const isString = type === "string" || (Array.isArray(type) && type.includes("string"))
		if (!isString && type !== undefined) continue
		if (Array.isArray(stringSchema.enum)) continue
		if (typeof stringSchema.pattern === "string") continue
		if (typeof stringSchema.format === "string") continue
		const maxLength = typeof stringSchema.maxLength === "number" ? stringSchema.maxLength : undefined
		const minLength = typeof stringSchema.minLength === "number" ? stringSchema.minLength : undefined
		if (maxLength !== undefined && maxLength < 8) continue
		const nullable =
			declared.nullable === true ||
			(Array.isArray(declared.type) && declared.type.includes("null")) ||
			(Array.isArray(union) &&
				union.some(
					(candidate) =>
						candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === "null",
				))
		const score = (nullable ? 1000 : 0) + (maxLength ?? 1024)
		if (best === null || score > best.score) best = { maxLength, minLength, name, score }
	}
	return best
}

const stringPayloadSurvives: Check = {
	applicable: (ctx) =>
		ctx.readOp !== undefined &&
		ctx.records.length > 0 &&
		(ctx.updateOp !== undefined || (ctx.createOp !== undefined && ctx.deleteOp !== undefined)),
	dependsOn: ["list.read-after-write"],
	id: "payload.string-survives",
	mutates: true,
	needs: "an update or create+delete, an item route, and a writable unconstrained string",
	async run(ctx) {
		const writeOp = ctx.updateOp ?? ctx.createOp
		const readOp = ctx.readOp
		if (writeOp === undefined || readOp === undefined) return
		const field = pickPayloadField(ctx, writeOp)
		if (field === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no writable unconstrained string field is available to probe payloads against",
			)
		}

		const viaPatch = ctx.updateOp !== undefined
		const target = ctx.records.at(-1) ?? ctx.records[0]
		if (target === undefined) return
		const id = String(target[ctx.identity])
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const original = target[field.name]

		const writeField = async (value: unknown, recordId: string): Promise<Exchange> => {
			if (viaPatch && ctx.updateOp !== undefined) {
				return ctx.client.request(
					"PATCH",
					fillPath(ctx.updateOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }),
					{
						body: { [field.name]: value },
						headers: ctx.auth(),
					},
				)
			}
			const createOp = ctx.createOp
			if (createOp === undefined) throw new Error("payload probe has no write operation")
			const body = { ...validBody(ctx, requestSchemaOf(ctx, createOp) ?? {}), [field.name]: value }
			return ctx.client.request("POST", fillPath(createOp.path, ctx.scope), { body, headers: ctx.auth() })
		}

		const readField = async (recordId: string): Promise<{ exchange: Exchange; value: unknown }> => {
			const exchange = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }), {
				headers: ctx.auth(),
			})
			const body = (exchange.responseBody ?? {}) as Record_
			return { exchange, value: body[field.name] }
		}

		const remove = async (recordId: string): Promise<void> => {
			if (viaPatch || ctx.deleteOp === undefined) return
			await ctx.client.request(
				"DELETE",
				fillPath(ctx.deleteOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }),
				{
					headers: ctx.auth(),
				},
			)
		}

		const identityOf = (exchange: Exchange): string | undefined => {
			const body = exchange.responseBody
			if (body === null || typeof body !== "object") return undefined
			const value = (body as Record_)[ctx.identity]
			return value === undefined || value === null ? undefined : String(value)
		}

		try {
			const control = await writeField(ASCII_PAYLOAD_PROBE, id)
			if (standDownForFeatureGate(ctx, writeOp, control, this.id)) return
			if (standDownForRateLimit(ctx, control, this.id)) return
			if (control.status === 401 || control.status === 403) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					`the ASCII control write returned ${control.status}, so later refusals cannot be attributed to the payload`,
				)
			}
			if (control.status >= 400 && control.status < 500) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					`the ASCII control write was rejected with ${control.status}, so the field refuses ordinary strings`,
				)
			}
			if (control.status >= 500) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an ordinary ASCII write returned 5xx",
					`PATCH/POST of "${ASCII_PAYLOAD_PROBE}" on "${field.name}" returned ${control.status}.`,
					[control],
				)
				return
			}
			const controlId = viaPatch ? id : identityOf(control)
			if (controlId === undefined) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"the ASCII control write did not return an identity, so the value could not be read back",
				)
			}
			const controlRead = await readField(controlId)
			if (!viaPatch) await remove(controlId)
			if (controlRead.value !== ASCII_PAYLOAD_PROBE) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an ordinary ASCII write did not persist exactly",
					`"${field.name}" was sent ${JSON.stringify(ASCII_PAYLOAD_PROBE)} and read back ` +
						`${JSON.stringify(controlRead.value)}.`,
					[control, controlRead.exchange],
				)
				return
			}

			const failed: string[] = []
			const evidence: Exchange[] = []
			let lostAuth = false
			for (const payload of STRING_PAYLOADS) {
				if (!payloadFits(payload.value, field.maxLength, field.minLength)) continue
				const written = await writeField(payload.value, id)
				if (standDownForFeatureGate(ctx, writeOp, written, this.id)) return
				if (written.status === 401) {
					const retry = await writeField(ASCII_PAYLOAD_PROBE, id)
					if (retry.status >= 400) {
						lostAuth = true
						break
					}
					failed.push(`${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got HTTP 401`)
					if (evidence.length < 4) evidence.push(written)
					continue
				}
				if (standDownForRateLimit(ctx, written, this.id)) return
				if (written.status === 404 || written.status === 409 || written.status === 415) {
					continue
				}
				if (written.status >= 400 && written.status < 500) {
					failed.push(
						`${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got HTTP ${written.status}`,
					)
					if (evidence.length < 4) evidence.push(written)
					if (!viaPatch) {
						const extra = identityOf(written)
						if (extra !== undefined) await remove(extra)
					}
					continue
				}
				if (written.status >= 500) {
					failed.push(
						`${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got HTTP ${written.status}`,
					)
					if (evidence.length < 4) evidence.push(written)
					continue
				}
				const writtenId = viaPatch ? id : identityOf(written)
				if (writtenId === undefined) {
					failed.push(`${payload.id} (${payload.why}): write succeeded but returned no identity`)
					continue
				}
				const got = await readField(writtenId)
				if (!viaPatch) await remove(writtenId)
				if (got.value !== payload.value) {
					failed.push(
						`${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got ${JSON.stringify(got.value)}`,
					)
					if (evidence.length < 4) evidence.push(written, got.exchange)
				}
			}

			if (lostAuth && failed.length === 0) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"authentication failed in the middle of the payload catalog, so remaining cases were not run",
				)
			}
			if (failed.length === 0) return
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a documented-valid string did not survive a write",
				`"${field.name}" failed ${failed.length} payload case(s): ${failed.slice(0, 6).join("; ")}` +
					(failed.length > 6 ? `; and ${failed.length - 6} more` : "") +
					". The document accepts these as strings; refusing or mutating them is silent corruption " +
					"or an undocumented constraint.",
				evidence,
			)
		} finally {
			if (viaPatch && ctx.updateOp !== undefined) {
				await ctx.client.request("PATCH", fillPath(ctx.updateOp.path, params), {
					body: { [field.name]: original ?? null },
					headers: ctx.auth(),
				})
			}
		}
	},
}

function resolveEntityOperation(ctx: CheckContext, method: string, pathname: string): OperationModel | null {
	let best: OperationModel | null = null
	for (const op of ctx.model.operations) {
		if (op.method !== method) continue
		if (op.entity !== ctx.entityName) continue
		if (!pathTemplateMatches(op.path, pathname)) continue
		if (best === null || op.path.length > best.path.length) best = op
	}
	return best
}

function statusIsDeclared(raw: OperationObject | undefined, status: number): boolean {
	const keys = Object.keys(raw?.responses ?? {})
	if (keys.includes(String(status))) return true
	return keys.includes(`${Math.floor(status / 100)}XX`)
}

function declaresConcreteStatuses(raw: OperationObject | undefined): boolean {
	return Object.keys(raw?.responses ?? {}).some((key) => /^\d{3}$/.test(key) || /^[1-5]XX$/i.test(key))
}

const documentedStatusHonoured: Check = {
	applicable: (ctx) => ctx.model.operations.some((op) => op.entity === ctx.entityName && op.action !== "create"),
	id: "response.status-is-documented",
	needs: "a modeled non-create operation on this entity",
	async run(ctx) {
		const createId = ctx.createOp?.operationId
		const byOp = new Map<string, Exchange[]>()
		for (const exchange of ctx.client.transcript) {
			let pathname: string
			try {
				pathname = new URL(exchange.url).pathname
			} catch {
				continue
			}
			const op = resolveEntityOperation(ctx, exchange.method, pathname)
			if (op === null) continue
			if (op.operationId === createId || op.action === "create") continue
			if (isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) continue
			if (exchange.status === 429) continue
			const raw = ctx.model.rawOperations.get(op.operationId)
			if (!declaresConcreteStatuses(raw)) continue
			if (statusIsDeclared(raw, exchange.status)) continue
			const seen = byOp.get(op.operationId) ?? []
			seen.push(exchange)
			byOp.set(op.operationId, seen)
		}
		if (byOp.size === 0) return

		const lines: string[] = []
		const evidence: Exchange[] = []
		for (const [operationId, exchanges] of byOp) {
			const raw = ctx.model.rawOperations.get(operationId)
			const declared = Object.keys(raw?.responses ?? {})
				.filter((key) => key !== "default")
				.sort()
				.join(", ")
			const seen = [...new Set(exchanges.map((item) => item.status))].sort((a, b) => a - b)
			lines.push(
				`${operationId} returned ${seen.join(", ")}; the document declares ${declared || "no concrete status"}`,
			)
			const first = exchanges[0]
			if (first !== undefined && evidence.length < 6) evidence.push(first)
		}

		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"an operation returned a status the document does not declare",
			`${lines.join(". ")}. Clients generated from this document will not recognise the response.`,
			evidence,
		)
	},
}

function pickFieldForOp(
	ctx: CheckContext,
	op: (typeof FILTER_OPS)[number],
	minDistinct = 2,
): { field: EffectiveFilterField; values: unknown[] } | null {
	for (const field of fieldsAllowing(ctx, op)) {
		const values = distinctValues(ctx.records, field.field)
		if (values.length >= minDistinct) return { field, values }
	}
	return null
}

function pickOrderedField(ctx: CheckContext): { field: EffectiveFilterField; values: number[] } | null {
	const caps = resolvedCaps(ctx)
	for (const field of caps.filterable) {
		if (field.type !== undefined && !ORDERED_TYPES.has(field.type)) continue
		if (!canUseOp(ctx, field, "gt") || !canUseOp(ctx, field, "lt") || !canUseOp(ctx, field, "eq")) continue
		const values = ctx.records.map((r) => r[field.field]).filter((v): v is number => typeof v === "number")
		if (values.length < 3) continue
		return { field, values }
	}
	return null
}

const FOUNDATIONS = [
	"list.read-after-write",
	"create.persists-submitted-fields",
	"pagination.page-walk-covers-set",
] as const

const filterInIsUnionOfEq: Check = {
	applicable: (ctx) => filterable(ctx) && pickFieldForOp(ctx, "in", 2) !== null,
	dependsOn: [...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.in-is-union-of-eq",
	needs: "a field that allows `in` and at least two distinct values",
	async run(ctx) {
		const picked = pickFieldForOp(ctx, "in", 2)
		if (picked === null) return
		const [a, b] = picked.values
		if (a === undefined || b === undefined) return
		const conventions = conv(ctx)
		const inTerm = filterTerm(conventions, picked.field.field, "in", [asTermValue(a), asTermValue(b)])
		const eqA = filterTerm(conventions, picked.field.field, "eq", asTermValue(a))
		const eqB = filterTerm(conventions, picked.field.field, "eq", asTermValue(b))
		if (inTerm === null || eqA === null || eqB === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const together = await collectSet(ctx, limit, inTerm)
		const onlyA = await collectSet(ctx, limit, eqA)
		const onlyB = await collectSet(ctx, limit, eqB)
		if (together === null || onlyA === null || onlyB === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for in() was rejected")
		}
		if (!together.complete || !onlyA.complete || !onlyB.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expected = new Set([...ids(onlyA.items, ctx.identity), ...ids(onlyB.items, ctx.identity)])
		const got = setOf(together.items, ctx.identity)
		if (sameSet(expected, got)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"in() is not the union of the equalities it lists",
			`${picked.field.field}.in.(${String(a)},${String(b)}) returned ${got.size} record(s); ` +
				`eq on each value together match ${expected.size}.`,
			[together.last.exchange, onlyA.last.exchange, onlyB.last.exchange],
		)
	},
}

const filterNinComplementsIn: Check = {
	applicable: (ctx) =>
		filterable(ctx) && pickFieldForOp(ctx, "in", 1) !== null && pickFieldForOp(ctx, "nin", 1) !== null,
	dependsOn: [...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.nin-complements-in",
	needs: "a field that allows both `in` and `nin`",
	async run(ctx) {
		const picked = pickFieldForOp(ctx, "in", 1)
		if (picked === null || !canUseOp(ctx, picked.field, "nin")) return
		const value = picked.values[0]
		if (value === undefined) return
		const conventions = conv(ctx)
		const inTerm = filterTerm(conventions, picked.field.field, "in", [asTermValue(value)])
		const ninTerm = filterTerm(conventions, picked.field.field, "nin", [asTermValue(value)])
		if (inTerm === null || ninTerm === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const all = await collectSet(ctx, limit)
		const inside = await collectSet(ctx, limit, inTerm)
		const outside = await collectSet(ctx, limit, ninTerm)
		if (all === null || inside === null || outside === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for nin() was rejected")
		}
		if (!all.complete || !inside.complete || !outside.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const inIds = setOf(inside.items, ctx.identity)
		const ninIds = setOf(outside.items, ctx.identity)
		const overlap = [...inIds].filter((id) => ninIds.has(id))
		if (overlap.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"in() and nin() both match the same record",
				`${overlap.length} record(s) appear in both ${picked.field.field}.in and .nin.`,
				[inside.last.exchange, outside.last.exchange],
			)
			return
		}
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => String(row[ctx.identity]) === id)
			return record !== undefined && record[picked.field.field] !== null && record[picked.field.field] !== undefined
		})
		const union = new Set([...inIds, ...ninIds])
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"in() and nin() do not cover the non-null set",
			`${missing.length} non-null record(s) match neither side.`,
			[all.last.exchange, inside.last.exchange, outside.last.exchange],
		)
	},
}

const filterGteIsGtOrEq: Check = {
	applicable: (ctx) => pickOrderedField(ctx) !== null && fieldsAllowing(ctx, "gte").length > 0,
	dependsOn: [...FOUNDATIONS, "filter.equality-selects-exactly-one", "filter.numeric-comparison-is-numeric"],
	id: "filter.gte-is-gt-or-eq",
	needs: "an ordered field that allows `gte` and `gt`",
	async run(ctx) {
		const picked = pickOrderedField(ctx)
		if (picked === null || !canUseOp(ctx, picked.field, "gte")) return
		const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 3)]
		if (threshold === undefined) return
		await assertRangeUnion(ctx, this.id, picked.field.field, "gte", "gt", threshold)
	},
}

const filterLteIsLtOrEq: Check = {
	applicable: (ctx) => pickOrderedField(ctx) !== null && fieldsAllowing(ctx, "lte").length > 0,
	dependsOn: [...FOUNDATIONS, "filter.equality-selects-exactly-one", "filter.numeric-comparison-is-numeric"],
	id: "filter.lte-is-lt-or-eq",
	needs: "an ordered field that allows `lte` and `lt`",
	async run(ctx) {
		const picked = pickOrderedField(ctx)
		if (picked === null || !canUseOp(ctx, picked.field, "lte")) return
		const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 3)]
		if (threshold === undefined) return
		await assertRangeUnion(ctx, this.id, picked.field.field, "lte", "lt", threshold)
	},
}

async function assertRangeUnion(
	ctx: CheckContext,
	check: string,
	field: string,
	closed: "gte" | "lte",
	open: "gt" | "lt",
	threshold: number,
): Promise<void> {
	const conventions = conv(ctx)
	const closedTerm = filterTerm(conventions, field, closed, threshold)
	const openTerm = filterTerm(conventions, field, open, threshold)
	const eqTerm = filterTerm(conventions, field, "eq", threshold)
	if (closedTerm === null || openTerm === null || eqTerm === null) return
	const limit = ctx.query?.maxLimit ?? 100
	const closedSet = await collectSet(ctx, limit, closedTerm)
	const openSet = await collectSet(ctx, limit, openTerm)
	const eqSet = await collectSet(ctx, limit, eqTerm)
	if (closedSet === null || openSet === null || eqSet === null) {
		return ctx.findings.unresolved(check, ctx.entityName, "one of the range listings was rejected")
	}
	if (!closedSet.complete || !openSet.complete || !eqSet.complete) {
		return ctx.findings.unresolved(check, ctx.entityName, "the collection is larger than the walk covers")
	}
	const expected = new Set([...ids(openSet.items, ctx.identity), ...ids(eqSet.items, ctx.identity)])
	const got = setOf(closedSet.items, ctx.identity)
	if (sameSet(expected, got)) return
	ctx.findings.backend(
		check,
		ctx.entityName,
		`${closed} is not ${open} ∪ eq`,
		`${field}.${closed}.${threshold} returned ${got.size}; ${open} ∪ eq is ${expected.size}.`,
		[closedSet.last.exchange, openSet.last.exchange, eqSet.last.exchange],
	)
}

const filterOrderedTriplePartitions: Check = {
	applicable: (ctx) => pickOrderedField(ctx) !== null,
	dependsOn: [...FOUNDATIONS, "filter.equality-selects-exactly-one", "filter.numeric-comparison-is-numeric"],
	id: "filter.ordered-triple-partitions",
	needs: "an ordered field that allows `lt`, `eq`, and `gt`",
	async run(ctx) {
		const picked = pickOrderedField(ctx)
		if (picked === null) return
		const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 2)]
		if (threshold === undefined) return
		const conventions = conv(ctx)
		const lt = filterTerm(conventions, picked.field.field, "lt", threshold)
		const eq = filterTerm(conventions, picked.field.field, "eq", threshold)
		const gt = filterTerm(conventions, picked.field.field, "gt", threshold)
		if (lt === null || eq === null || gt === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const all = await collectSet(ctx, limit)
		const lower = await collectSet(ctx, limit, lt)
		const equal = await collectSet(ctx, limit, eq)
		const higher = await collectSet(ctx, limit, gt)
		if (all === null || lower === null || equal === null || higher === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the triple listings was rejected")
		}
		if (!all.complete || !lower.complete || !equal.complete || !higher.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const sets = [setOf(lower.items, ctx.identity), setOf(equal.items, ctx.identity), setOf(higher.items, ctx.identity)]
		for (let i = 0; i < sets.length; i++) {
			for (let j = i + 1; j < sets.length; j++) {
				const left = sets[i]
				const right = sets[j]
				if (left === undefined || right === undefined) continue
				const overlap = [...left].filter((id) => right.has(id))
				if (overlap.length > 0) {
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						"lt / eq / gt are not pairwise disjoint",
						`${overlap.length} record(s) appear in more than one of ${picked.field.field} lt/eq/gt.`,
						[lower.last.exchange, equal.last.exchange, higher.last.exchange],
					)
					return
				}
			}
		}
		const union = new Set([...(sets[0] ?? []), ...(sets[1] ?? []), ...(sets[2] ?? [])])
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => String(row[ctx.identity]) === id)
			return record !== undefined && typeof record[picked.field.field] === "number"
		})
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"lt ∪ eq ∪ gt does not cover the numeric set",
			`${missing.length} numeric record(s) match none of the three predicates.`,
			[all.last.exchange, lower.last.exchange, equal.last.exchange, higher.last.exchange],
		)
	},
}

const filterIlikeIsCaseInsensitive: Check = {
	applicable: (ctx) => fieldsAllowing(ctx, "ilike").some((field) => canUseOp(ctx, field, "like")),
	dependsOn: [...FOUNDATIONS, "filter.like-metacharacters-escaped"],
	id: "filter.ilike-is-case-insensitive",
	needs: "a field that allows both `ilike` and `like`, and a string with a letter",
	async run(ctx) {
		const field = fieldsAllowing(ctx, "ilike").find((item) => canUseOp(ctx, item, "like"))
		if (field === undefined) return
		const sample = ctx.records
			.map((row) => row[field.field])
			.find((value): value is string => typeof value === "string" && /[A-Za-z]/.test(value))
		if (sample === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no searchable string on the field has a letter")
		}
		const flipped = sample.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		if (flipped === sample) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "could not case-flip a letter in the sample")
		}
		const conventions = conv(ctx)
		const likeTerm = filterTerm(conventions, field.field, "like", flipped)
		const ilikeTerm = filterTerm(conventions, field.field, "ilike", flipped)
		if (likeTerm === null || ilikeTerm === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const like = await list(ctx, { ...q(ctx, { limit }), ...likeTerm })
		const ilike = await list(ctx, { ...q(ctx, { limit }), ...ilikeTerm })
		if (like.exchange.status >= 400 || ilike.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "like/ilike probe was rejected")
		}
		const likeHits = ids(like.items, ctx.identity)
		const ilikeHits = ids(ilike.items, ctx.identity)
		const original = ctx.records.filter((row) => row[field.field] === sample).map((row) => String(row[ctx.identity]))
		if (original.some((id) => ilikeHits.includes(id)) && !original.some((id) => likeHits.includes(id))) return
		if (original.some((id) => ilikeHits.includes(id)) && original.some((id) => likeHits.includes(id))) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"like also matched the case-flipped value — the store may already be case-insensitive",
			)
		}
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"ilike is not case-insensitive relative to like",
			`ilike on ${JSON.stringify(flipped)} did not select the record whose ${field.field} is ${JSON.stringify(sample)}.`,
			[like.exchange, ilike.exchange],
		)
	},
}

function mixedNullField(ctx: CheckContext, field: string): boolean {
	if (ctx.softDelete !== null && field === ctx.softDelete) return false
	const values = ctx.records.map((row) => row[field])
	const nulls = values.filter((value) => value === null || value === undefined).length
	return nulls > 0 && nulls < values.length
}

const filterIsNullSelectsNulls: Check = {
	applicable: (ctx) => fieldsAllowing(ctx, "is").some((field) => mixedNullField(ctx, field.field)),
	dependsOn: [...FOUNDATIONS],
	id: "filter.is-null-selects-nulls",
	needs: "a field that allows `is` and a cohort that contains a null",
	async run(ctx) {
		const field = fieldsAllowing(ctx, "is").find((item) => mixedNullField(ctx, item.field))
		if (field === undefined) return
		const conventions = conv(ctx)
		const nullTerm = filterTerm(conventions, field.field, "is", "null")
		const notNullTerm = filterTerm(conventions, field.field, "is", "notnull")
		if (nullTerm === null || notNullTerm === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const all = await collectSet(ctx, limit)
		const nulls = await collectSet(ctx, limit, nullTerm)
		const present = await collectSet(ctx, limit, notNullTerm)
		if (all === null || nulls === null || present === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "an is.null / is.notnull listing was rejected")
		}
		if (!all.complete || !nulls.complete || !present.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expectedNulls = new Set(
			ctx.records
				.filter((row) => row[field.field] === null || row[field.field] === undefined)
				.map((row) => String(row[ctx.identity])),
		)
		const gotNulls = knownHits(nulls.items, ctx)
		const overlap = [...gotNulls].filter((id) => knownHits(present.items, ctx).has(id))
		if (!sameSet(expectedNulls, gotNulls) || overlap.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"is.null / is.notnull do not partition on nulls",
				`is.null returned ${gotNulls.size} record(s); ${expectedNulls.size} cohort rows are null. ` +
					(overlap.length > 0 ? `${overlap.length} appear on both sides.` : ""),
				[nulls.last.exchange, present.last.exchange],
			)
		}
	},
}

const filterContainsMembership: Check = {
	applicable: (ctx) =>
		resolvedCaps(ctx).filterable.some(
			(field) =>
				(field.type === "array" || fieldAllows(field, "contains", resolvedCaps(ctx))) &&
				canWriteFilterOp(conv(ctx), "contains") &&
				ctx.records.some((row) => Array.isArray(row[field.field]) && (row[field.field] as unknown[]).length > 0),
		),
	dependsOn: [...FOUNDATIONS],
	id: "filter.contains-membership",
	needs: "an array field that allows `contains` and a known element",
	async run(ctx) {
		const field = resolvedCaps(ctx).filterable.find(
			(item) =>
				canUseOp(ctx, item, "contains") &&
				ctx.records.some((row) => Array.isArray(row[item.field]) && (row[item.field] as unknown[]).length > 0),
		)
		if (field === undefined) return
		const sample = ctx.records.find(
			(row) => Array.isArray(row[field.field]) && (row[field.field] as unknown[]).length > 0,
		)
		const element = Array.isArray(sample?.[field.field]) ? (sample[field.field] as unknown[])[0] : undefined
		if (element === undefined) return
		const term = filterTerm(conv(ctx), field.field, "contains", asTermValue(element))
		if (term === null) return
		const result = await collectSet(ctx, ctx.query?.maxLimit ?? 100, term)
		if (result === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "contains probe was rejected")
		}
		if (!result.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expected = new Set(
			ctx.records
				.filter(
					(row) =>
						Array.isArray(row[field.field]) &&
						(row[field.field] as unknown[]).some((item) => String(item) === String(element)),
				)
				.map((row) => String(row[ctx.identity])),
		)
		const got = knownHits(result.items, ctx)
		if (sameSet(expected, got)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"contains does not select membership of the given element",
			`${field.field}.contains.${String(element)} returned ${got.size}; ${expected.size} records hold that element.`,
			[result.last.exchange],
		)
	},
}

const filterNestedAndOrDistributes: Check = {
	applicable: (ctx) => conv(ctx).grammar === "postgrest" && filterableNames(ctx).length > 1,
	dependsOn: [...FOUNDATIONS, "filter.and-composes-as-intersection", "filter.or-composes-as-union"],
	id: "filter.nested-and-or-distributes",
	needs: "a postgrest-shaped grammar and two filterable fields",
	async run(ctx) {
		const picked = twoFilterableFields(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no record holds two non-null filterable fields")
		}
		const idField = filterIdentity(ctx)
		if (idField === picked.fieldA || idField === picked.fieldB || !identityIsFilterable(ctx)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "need a third identity filter term to nest and/or")
		}
		const conventions = conv(ctx)
		const fragA = filterFragment(conventions, picked.fieldA, String(picked.target[picked.fieldA]))
		const fragB = filterFragment(conventions, picked.fieldB, String(picked.target[picked.fieldB]))
		const fragC = filterFragment(conventions, idField, String(picked.target[ctx.identity]))
		if (fragA === null || fragB === null || fragC === null || conventions.filter === undefined) return
		const nested = { [conventions.filter]: `and(${fragA},or(${fragB},${fragC}))` }
		const termA = filterTerm(conventions, picked.fieldA, "eq", String(picked.target[picked.fieldA]))
		const termB = filterTerm(conventions, picked.fieldB, "eq", String(picked.target[picked.fieldB]))
		const termC = filterTerm(conventions, idField, "eq", String(picked.target[ctx.identity]))
		if (termA === null || termB === null || termC === null) return
		const limit = ctx.query?.maxLimit ?? 100
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const onlyC = await collectSet(ctx, limit, termC)
		const combined = await collectSet(ctx, limit, nested)
		if (onlyA === null || onlyB === null || onlyC === null || combined === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a nested and/or listing was rejected")
		}
		if (!onlyA.complete || !onlyB.complete || !onlyC.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		const setC = setOf(onlyC.items, ctx.identity)
		const expected = new Set([...setA].filter((id) => setB.has(id) || setC.has(id)))
		const got = setOf(combined.items, ctx.identity)
		if (sameSet(expected, got)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and(A,or(B,C)) is not (A∩B) ∪ (A∩C)",
			`nested combinator returned ${got.size}; the distributed form is ${expected.size}.`,
			[combined.last.exchange, onlyA.last.exchange, onlyB.last.exchange, onlyC.last.exchange],
		)
	},
}

const filterAliasMatchesCanonical: Check = {
	applicable: (ctx) => Object.keys(resolvedCaps(ctx).aliases).length > 0 && filterable(ctx),
	dependsOn: [...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.alias-matches-canonical",
	needs: "a declared filter operator alias",
	async run(ctx) {
		const caps = resolvedCaps(ctx)
		const conventions = conv(ctx)
		const limit = ctx.query?.maxLimit ?? 100
		for (const [alias, target] of Object.entries(caps.aliases)) {
			if (!isFilterOp(alias) || target === undefined) continue
			const field = resolvedCaps(ctx).filterable.find((item) => fieldAllows(item, target, caps))
			if (field === undefined || !canWriteFilterOp(conventions, alias)) continue
			const sample = ctx.records.find((row) => row[field.field] != null)
			if (sample === undefined) continue
			const value = asTermValue(sample[field.field])
			const aliasTerm = filterTerm(conventions, field.field, alias, value)
			const targetTerm = filterTerm(conventions, field.field, target, value)
			if (aliasTerm === null || targetTerm === null) continue
			const left = await collectSet(ctx, limit, aliasTerm)
			const right = await collectSet(ctx, limit, targetTerm)
			if (left === null || right === null) {
				return ctx.findings.unresolved(this.id, ctx.entityName, `alias ${alias} or ${target} was rejected`)
			}
			if (!sameSet(setOf(left.items, ctx.identity), setOf(right.items, ctx.identity))) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					`alias ${alias} does not select the same set as ${target}`,
					`${field.field}.${alias} and ${field.field}.${target} disagreed on membership.`,
					[left.last.exchange, right.last.exchange],
				)
				return
			}
		}
	},
}

function firstIllegalOp(ctx: CheckContext, field: EffectiveFilterField): (typeof FILTER_OPS)[number] | undefined {
	const caps = resolvedCaps(ctx)
	if (!opsAreClosed(field, caps)) return undefined
	const allowed = new Set(opsForField(field, caps))
	return FILTER_OPS.find((op) => !allowed.has(op) && canWriteFilterOp(conv(ctx), op))
}

const filterIllegalOpRejected: Check = {
	applicable: (ctx) => resolvedCaps(ctx).filterable.some((field) => firstIllegalOp(ctx, field) !== undefined),
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected", "error.malformed-filter-not-5xx"],
	id: "filter.illegal-op-rejected",
	needs: "a field with a closed operator list",
	async run(ctx) {
		const field = resolvedCaps(ctx).filterable.find((item) => firstIllegalOp(ctx, item) !== undefined)
		const op = field === undefined ? undefined : firstIllegalOp(ctx, field)
		if (field === undefined || op === undefined) return
		const sample = ctx.records.find((row) => row[field.field] != null)
		const term = filterTerm(
			conv(ctx),
			field.field,
			op,
			sample === undefined ? "oat-probe" : asTermValue(sample[field.field]),
		)
		if (term === null) return
		const baseline = await list(ctx, q(ctx, { limit: 100 }))
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...term })
		if (result.exchange.status >= 500) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an illegal filter operator produces a server error",
				`${field.field}.${op} returned ${result.exchange.status}; a rejected operator should be 4xx.`,
				[result.exchange],
			)
			return
		}
		if (result.exchange.status >= 400) return
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an illegal filter operator is accepted",
			`${field.field}.${op} returned ${result.exchange.status}` +
				(same ? " with the unfiltered set, so the operator was ignored" : "") +
				". A closed operator list is a contract: anything outside it must be rejected.",
			[baseline.exchange, result.exchange],
		)
	},
}

const filterEmptyIn: Check = {
	applicable: (ctx) => resolvedCaps(ctx).emptyIn !== undefined && pickFieldForOp(ctx, "in", 1) !== null,
	dependsOn: [...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.empty-in",
	needs: "`emptyIn` declared and a field that allows `in`",
	async run(ctx) {
		const picked = pickFieldForOp(ctx, "in", 1)
		const policy = resolvedCaps(ctx).emptyIn
		if (picked === null || policy === undefined) return
		const term = filterTerm(conv(ctx), picked.field.field, "in", [])
		if (term === null) return
		const baseline = await list(ctx, q(ctx, { limit: 100 }))
		const result = await list(ctx, { ...q(ctx, { limit: 100 }), ...term })
		if (policy === "reject") {
			if (result.exchange.status >= 400 && result.exchange.status < 500) return
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"empty in() was not rejected",
				`emptyIn=reject but ${picked.field.field}.in.() returned ${result.exchange.status}.`,
				[result.exchange],
			)
			return
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty in() was rejected under match-none")
		}
		if (result.items.length === 0) return
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"empty in() did not match none",
			`emptyIn=match-none but ${picked.field.field}.in.() returned ${result.items.length} record(s)` +
				(same ? " — the unfiltered set, so the filter was ignored" : "") +
				".",
			[baseline.exchange, result.exchange],
		)
	},
}

const filterInOverLimitRejected: Check = {
	applicable: (ctx) => resolvedCaps(ctx).maxInValues !== undefined && pickFieldForOp(ctx, "in", 1) !== null,
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.in-over-limit-rejected",
	needs: "`maxInValues` declared and a field that allows `in`",
	async run(ctx) {
		const max = resolvedCaps(ctx).maxInValues
		const picked = pickFieldForOp(ctx, "in", 1)
		if (max === undefined || picked === null) return
		const members = Array.from({ length: max + 1 }, (_, i) => `oat-over-limit-${i}`)
		const term = filterTerm(conv(ctx), picked.field.field, "in", members)
		if (term === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...term })
		if (result.exchange.status >= 400 && result.exchange.status < 500) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit in() list was accepted",
			`maxInValues=${max} but ${picked.field.field}.in with ${max + 1} members returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
}

const filterConditionCapRejected: Check = {
	applicable: (ctx) =>
		resolvedCaps(ctx).maxFilterConditions !== undefined &&
		conv(ctx).grammar === "postgrest" &&
		identityIsFilterable(ctx),
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.condition-cap-rejected",
	needs: "`maxFilterConditions` declared and a grammar that can group eq terms",
	async run(ctx) {
		const max = resolvedCaps(ctx).maxFilterConditions
		const parameter = conv(ctx).filter
		if (max === undefined || parameter === undefined) return
		const field = filterIdentity(ctx)
		const terms = Array.from({ length: max + 1 }, () => `${field}.eq.oat-cap`)
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), [parameter]: `and(${terms.join(",")})` })
		if (result.exchange.status >= 400 && result.exchange.status < 500) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit filter expression was accepted",
			`maxFilterConditions=${max} but ${max + 1} eq terms returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
}

function probeValueForOp(
	ctx: CheckContext,
	field: EffectiveFilterField,
	op: (typeof FILTER_OPS)[number],
): string | number | readonly (string | number)[] | null {
	const sample = ctx.records.find((row) => row[field.field] != null)
	if (op === "is") return "null"
	if (op === "in" || op === "nin") return [sample === undefined ? "oat-probe" : asTermValue(sample[field.field])]
	if (op === "contains") {
		const arr = sample?.[field.field]
		if (Array.isArray(arr) && arr[0] !== undefined) return asTermValue(arr[0])
		return "oat-probe"
	}
	if (sample === undefined) return "oat-probe"
	return asTermValue(sample[field.field])
}

const declaredFilterableOpsAccepted: Check = {
	applicable: (ctx) =>
		ctx.query?.source === "tag" && resolvedCaps(ctx).filterable.some((field) => opsAreClosed(field, resolvedCaps(ctx))),
	dependsOn: ["list.read-after-write", "spec.declared-filterable-is-filterable", "error.malformed-filter-not-5xx"],
	id: "spec.declared-filterable-ops-accepted",
	needs: "a closed operator list on at least one declared field",
	async run(ctx) {
		const caps = resolvedCaps(ctx)
		const rejected: string[] = []
		for (const field of caps.filterable) {
			if (!opsAreClosed(field, caps)) continue
			for (const op of opsForField(field, caps)) {
				if (!canWriteFilterOp(conv(ctx), op)) continue
				const term = filterTerm(conv(ctx), field.field, op, probeValueForOp(ctx, field, op))
				if (term === null) continue
				const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...term })
				if (result.exchange.status >= 400 && result.exchange.status < 500) {
					rejected.push(`${field.field}.${op} (${result.exchange.status})`)
				}
			}
		}
		if (rejected.length === 0) return
		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a filter operator the backend rejects",
			`declared ops that 4xx: ${rejected.slice(0, 8).join(", ")}.`,
			[],
		)
	},
}

const declaredFilterableIllegalOpRejected: Check = {
	applicable: (ctx) =>
		ctx.query?.source === "tag" &&
		resolvedCaps(ctx).filterable.some((field) => firstIllegalOp(ctx, field) !== undefined),
	dependsOn: ["filter.illegal-op-rejected", "spec.declared-filterable-is-filterable"],
	id: "spec.declared-filterable-illegal-op-rejected",
	needs: "a closed operator list on a declared field",
	async run(ctx) {
		await filterIllegalOpRejected.run(ctx)
	},
}

const sortUnknownFieldRejected: Check = {
	applicable: (ctx) => conv(ctx).order !== undefined,
	dependsOn: ["error.malformed-filter-not-5xx"],
	id: "sort.unknown-field-rejected",
	needs: "an order parameter",
	async run(ctx) {
		const result = await list(ctx, q(ctx, { limit: 5, order: sortTerm(conv(ctx), "oat_no_such_sort_xyz", "asc") }))
		if (result.exchange.status >= 500) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown sort field produces a server error",
				`ordering on an undeclared field returned ${result.exchange.status}; a rejected input should be 4xx.`,
				[result.exchange],
			)
			return
		}
		if (result.exchange.status >= 400) return
		const baseline = await list(ctx, q(ctx, { limit: 5 }))
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown sort field is silently ignored",
			`order on an undeclared field returned ${result.exchange.status}` +
				(same ? " with the default order, so the field was dropped" : "") +
				".",
			[baseline.exchange, result.exchange],
		)
	},
}

const sortNumericOrderIsNumeric: Check = {
	applicable: (ctx) =>
		conv(ctx).order !== undefined &&
		resolvedCaps(ctx).sortable.some((field) => numericLexicalDisagrees(ctx, field.field)),
	dependsOn: ["sort.order-is-applied"],
	id: "sort.numeric-order-is-numeric",
	needs: "a numeric sortable field whose lexical order disagrees with numeric order",
	async run(ctx) {
		const field = resolvedCaps(ctx).sortable.find((item) => numericLexicalDisagrees(ctx, item.field))
		if (field === undefined) return
		const result = await list(
			ctx,
			q(ctx, { limit: ctx.query?.maxLimit ?? 100, order: sortTerm(conv(ctx), field.field, "asc") }),
		)
		if (result.exchange.status >= 400) return
		const numbers = result.items.map((item) => item[field.field]).filter((v): v is number => typeof v === "number")
		const sorted = [...numbers].sort((a, b) => a - b)
		if (numbers.join(",") === sorted.join(",")) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			`"${field.field}" is sorted as text rather than as a number`,
			`order=${field.field}.asc returned ${numbers.slice(0, 8).join(", ")}.`,
			[result.exchange],
		)
	},
}

const sortNullsFirstLast: Check = {
	applicable: (ctx) =>
		conv(ctx).order !== undefined &&
		sortTermWithNulls(conv(ctx), "x", "asc", "first") !== null &&
		resolvedCaps(ctx).sortable.some(
			(field) =>
				(fieldAllowsNulls(field, resolvedCaps(ctx), "first") || fieldAllowsNulls(field, resolvedCaps(ctx), "last")) &&
				ctx.records.some((row) => row[field.field] === null || row[field.field] === undefined),
		),
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.nulls-first-last",
	needs: "a declared nulls token, a dotted sort grammar, and a null in the cohort",
	async run(ctx) {
		const field = resolvedCaps(ctx).sortable.find(
			(item) =>
				(fieldAllowsNulls(item, resolvedCaps(ctx), "first") || fieldAllowsNulls(item, resolvedCaps(ctx), "last")) &&
				ctx.records.some((row) => row[item.field] === null || row[item.field] === undefined),
		)
		if (field === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		if (fieldAllowsNulls(field, resolvedCaps(ctx), "first")) {
			const clause = sortTermWithNulls(conv(ctx), field.field, "asc", "first")
			if (clause === null) return
			const result = await collectSet(ctx, limit, {}, MAX_WALK_PAGES, clause)
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullsfirst listing was rejected")
			const first = result.items[0]
			if (first !== undefined && first[field.field] !== null && first[field.field] !== undefined) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullsfirst did not put nulls first",
					`order=${clause} started with ${JSON.stringify(first[field.field])}.`,
					[result.last.exchange],
				)
				return
			}
		}
		if (fieldAllowsNulls(field, resolvedCaps(ctx), "last")) {
			const clause = sortTermWithNulls(conv(ctx), field.field, "asc", "last")
			if (clause === null) return
			const result = await collectSet(ctx, limit, {}, MAX_WALK_PAGES, clause)
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullslast listing was rejected")
			const last = result.items.at(-1)
			if (last !== undefined && last[field.field] !== null && last[field.field] !== undefined) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullslast did not put nulls last",
					`order=${clause} ended with ${JSON.stringify(last[field.field])}.`,
					[result.last.exchange],
				)
			}
		}
	},
}

function pickMultiKeyPair(ctx: CheckContext): { primary: string; secondary: string; tied: Record_[] } | null {
	const fields = ctx.query?.sortable ?? []
	for (const primary of fields) {
		for (const secondary of fields) {
			if (secondary === primary || secondary === ctx.identity) continue
			const groups = new Map<string, Record_[]>()
			for (const row of ctx.records) {
				const key = JSON.stringify(row[primary])
				const group = groups.get(key) ?? []
				group.push(row)
				groups.set(key, group)
			}
			const tied = [...groups.values()].find(
				(group) => group.length >= 2 && new Set(group.map((row) => JSON.stringify(row[secondary]))).size > 1,
			)
			if (tied !== undefined) return { primary, secondary, tied }
		}
	}
	return null
}

const sortMultiKeyTiebreak: Check = {
	applicable: (ctx) => {
		const max = resolvedCaps(ctx).sort?.maxKeys
		return conv(ctx).order !== undefined && (max === undefined || max >= 2) && pickMultiKeyPair(ctx) !== null
	},
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.multi-key-tiebreak",
	needs: "two sortable fields and rows that tie on the first and differ on the second",
	async run(ctx) {
		const pair = pickMultiKeyPair(ctx)
		if (pair === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no cohort tie on the first key differs on the second")
		}
		const { primary, secondary, tied } = pair
		const conventions = conv(ctx)
		const order = `${sortTerm(conventions, primary, "asc")},${sortTerm(conventions, secondary, "asc")}`
		const result = await collectSet(ctx, ctx.query?.maxLimit ?? 100, {}, MAX_WALK_PAGES, order)
		if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "multi-key order was rejected")
		const slice = result.items.filter((item) => JSON.stringify(item[primary]) === JSON.stringify(tied[0]?.[primary]))
		const seconds = slice.map((item) => item[secondary])
		const sorted = [...seconds].sort(compareValues)
		if (JSON.stringify(seconds) === JSON.stringify(sorted)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"the second sort key is not applied on ties",
			`order=${order} left ties on "${primary}" unordered by "${secondary}".`,
			[result.last.exchange],
		)
	},
}

const sortDefaultOrderApplied: Check = {
	applicable: (ctx) =>
		(resolvedCaps(ctx).sort?.defaultOrder ?? ctx.query?.defaultOrder) !== undefined && ctx.records.length > 1,
	dependsOn: ["sort.order-is-applied", "pagination.page-walk-covers-set"],
	id: "sort.default-order-applied",
	needs: "a declared defaultOrder and a complete walk",
	async run(ctx) {
		const declared = resolvedCaps(ctx).sort?.defaultOrder ?? ctx.query?.defaultOrder
		if (declared === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const implicit = await collectSet(ctx, limit)
		const explicit = await collectSet(ctx, limit, {}, MAX_WALK_PAGES, declared)
		if (implicit === null || explicit === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "default-order walk was rejected")
		}
		if (!implicit.complete || !explicit.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the walk is incomplete, so default order cannot be compared",
			)
		}
		if (ids(implicit.items, ctx.identity).join(",") === ids(explicit.items, ctx.identity).join(",")) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"omitting order does not match defaultOrder",
			`defaultOrder=${declared} produced a different sequence than the implicit listing.`,
			[implicit.last.exchange, explicit.last.exchange],
		)
	},
}

const sortStableTiebreak: Check = {
	applicable: (ctx) => (resolvedCaps(ctx).sort?.stableTiebreak ?? ctx.query?.stableTiebreak) !== undefined,
	dependsOn: ["sort.order-is-applied"],
	id: "sort.stable-tiebreak",
	needs: "a declared stableTiebreak and a tie on the primary key",
	async run(ctx) {
		const tiebreak = resolvedCaps(ctx).sort?.stableTiebreak ?? ctx.query?.stableTiebreak
		const primary = ctx.query?.sortable.find((name) => name !== tiebreak) ?? ctx.query?.sortable[0]
		if (tiebreak === undefined || primary === undefined) return
		const order = sortTerm(conv(ctx), primary, "asc")
		const first = await collectSet(ctx, ctx.query?.maxLimit ?? 100, {}, MAX_WALK_PAGES, order)
		const second = await collectSet(ctx, ctx.query?.maxLimit ?? 100, {}, MAX_WALK_PAGES, order)
		if (first === null || second === null)
			return ctx.findings.unresolved(this.id, ctx.entityName, "repeat sort was rejected")
		if (ids(first.items, ctx.identity).join(",") === ids(second.items, ctx.identity).join(",")) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"the same order is not deterministic across two walks",
			`order=${order} (stableTiebreak=${tiebreak}) returned two different sequences.`,
			[first.last.exchange, second.last.exchange],
		)
	},
}

const declaredSortableNullsAccepted: Check = {
	applicable: (ctx) =>
		conv(ctx).order !== undefined &&
		sortTermWithNulls(conv(ctx), "x", "asc", "first") !== null &&
		resolvedCaps(ctx).sortable.some(
			(field) =>
				fieldAllowsNulls(field, resolvedCaps(ctx), "first") || fieldAllowsNulls(field, resolvedCaps(ctx), "last"),
		),
	dependsOn: ["sort.order-is-applied"],
	id: "spec.declared-sortable-nulls-accepted",
	needs: "a declared nulls token on a sortable field",
	async run(ctx) {
		const rejected: string[] = []
		for (const field of resolvedCaps(ctx).sortable) {
			for (const token of ["first", "last"] as const) {
				if (!fieldAllowsNulls(field, resolvedCaps(ctx), token)) continue
				const clause = sortTermWithNulls(conv(ctx), field.field, "asc", token)
				if (clause === null) continue
				const result = await list(ctx, q(ctx, { limit: 5, order: clause }))
				if (result.exchange.status >= 400 && result.exchange.status < 500) {
					rejected.push(`${clause} (${result.exchange.status})`)
				}
			}
		}
		if (rejected.length === 0) return
		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a nulls sort token the backend rejects",
			`rejected: ${rejected.join(", ")}.`,
			[],
		)
	},
}

const searchTokensAnd: Check = {
	applicable: (ctx) =>
		conv(ctx).search !== undefined && (ctx.query?.searchable.length ?? 0) > 0 && ctx.records.length > 2,
	dependsOn: ["search.q-narrows-result"],
	id: "search.tokens-and",
	needs: "searchable fields and two tokens that split the cohort",
	async run(ctx) {
		const field = ctx.query?.searchable[0]
		if (field === undefined) return
		const tokens: string[] = []
		for (const row of ctx.records) {
			const value = row[field]
			if (typeof value !== "string") continue
			const word = value.split(/\s+/).find((part) => part.length >= 3)
			if (word !== undefined) tokens.push(word.toLowerCase())
		}
		const unique = [...new Set(tokens)]
		if (unique.length < 2) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "could not find two discriminating search tokens")
		}
		const [a, b] = unique
		if (a === undefined || b === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const onlyA = await list(ctx, q(ctx, { limit, search: a }))
		const onlyB = await list(ctx, q(ctx, { limit, search: b }))
		const both = await list(ctx, q(ctx, { limit, search: `${a} ${b}` }))
		if (onlyA.exchange.status >= 400 || onlyB.exchange.status >= 400 || both.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a token search was rejected")
		}
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		const expected = new Set([...setA].filter((id) => setB.has(id)))
		const got = setOf(both.items, ctx.identity)
		if (sameSet(expected, got) || sameSet(got, new Set([...setA, ...setB]))) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"two search tokens are not applied as AND",
			`q="${a} ${b}" returned ${got.size}; the intersection of each token is ${expected.size}.`,
			[onlyA.exchange, onlyB.exchange, both.exchange],
		)
	},
}

const searchCaseInsensitive: Check = {
	applicable: (ctx) =>
		conv(ctx).search !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		ctx.records.some((row) =>
			ctx.query?.searchable.some((field) => typeof row[field] === "string" && /[A-Za-z]/.test(row[field] as string)),
		),
	dependsOn: ["search.q-narrows-result"],
	id: "search.case-insensitive",
	needs: "a searchable string with a letter",
	async run(ctx) {
		let sample: string | undefined
		for (const field of ctx.query?.searchable ?? []) {
			const value = ctx.records
				.map((row) => row[field])
				.find((item): item is string => typeof item === "string" && /[A-Za-z]/.test(item))
			if (value !== undefined) {
				sample = value
				break
			}
		}
		if (sample === undefined) return
		const token = sample.split(/\s+/).find((part) => /[A-Za-z]/.test(part)) ?? sample
		const flipped = token.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		const limit = ctx.query?.maxLimit ?? 100
		const original = await list(ctx, q(ctx, { limit, search: token }))
		const other = await list(ctx, q(ctx, { limit, search: flipped }))
		if (original.exchange.status >= 400 || other.exchange.status >= 400) return
		const a = setOf(original.items, ctx.identity)
		const b = setOf(other.items, ctx.identity)
		if (sameSet(a, b)) return
		if (resolvedCaps(ctx).searchCase === "insensitive") {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"search is not case-insensitive",
				`q=${JSON.stringify(token)} and q=${JSON.stringify(flipped)} selected different sets.`,
				[original.exchange, other.exchange],
			)
			return
		}
		ctx.findings.unresolved(
			this.id,
			ctx.entityName,
			"case-flipped search selected a different set; declare searchCase: insensitive to treat that as a defect",
		)
	},
}

const searchEmptyQ: Check = {
	applicable: (ctx) => conv(ctx).search !== undefined && resolvedCaps(ctx).searchEmpty !== undefined,
	dependsOn: ["search.q-narrows-result"],
	id: "search.empty-q",
	needs: "`searchEmpty` declared",
	async run(ctx) {
		const policy = resolvedCaps(ctx).searchEmpty
		if (policy === undefined) return
		const limit = ctx.query?.maxLimit ?? 100
		const baseline = await list(ctx, q(ctx, { limit }))
		const empty = await list(ctx, q(ctx, { limit, search: "" }))
		if (policy === "reject") {
			if (empty.exchange.status >= 400 && empty.exchange.status < 500) return
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"empty q was not rejected",
				`searchEmpty=reject but q= returned ${empty.exchange.status}.`,
				[empty.exchange],
			)
			return
		}
		if (empty.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty q was rejected")
		}
		if (sameSet(setOf(empty.items, ctx.identity), setOf(baseline.items, ctx.identity))) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"empty q did not match the unfiltered set",
			`searchEmpty=${policy} but q= returned ${empty.items.length} of ${baseline.items.length} records.`,
			[baseline.exchange, empty.exchange],
		)
	},
}

const searchUndeclaredFieldNotRequired: Check = {
	applicable: (ctx) => {
		if (conv(ctx).search === undefined || (ctx.query?.searchable.length ?? 0) === 0) return false
		const searchable = new Set(ctx.query?.searchable ?? [])
		return ctx.records.some((row) =>
			Object.entries(row).some(
				([key, value]) =>
					!searchable.has(key) && typeof value === "string" && value.length >= 4 && !searchableHasToken(ctx, value),
			),
		)
	},
	dependsOn: ["search.q-narrows-result"],
	id: "search.undeclared-field-not-required",
	needs: "a searchable field and a non-searchable string",
	async run() {
		/* Extra recall is not a defect. This check exists so undeclared-field hits are not
		 * reported as SEARCH_IGNORED by other checks. */
	},
}

function searchableHasToken(ctx: CheckContext, token: string): boolean {
	const needle = token.toLowerCase()
	return ctx.records.some((row) =>
		(ctx.query?.searchable ?? []).some((field) =>
			String(row[field] ?? "")
				.toLowerCase()
				.includes(needle),
		),
	)
}

const searchModeAccepted: Check = {
	applicable: (ctx) =>
		conv(ctx).searchMode !== undefined &&
		(resolvedCaps(ctx).searchModes?.length ?? 0) > 0 &&
		conv(ctx).search !== undefined,
	id: "search.mode-accepted",
	needs: "declared searchModes and a search-mode parameter",
	async run(ctx) {
		const rejected: string[] = []
		for (const mode of resolvedCaps(ctx).searchModes ?? []) {
			const result = await list(ctx, q(ctx, { limit: 5, search: "oat", searchMode: mode }))
			if (result.exchange.status >= 400 && result.exchange.status < 500)
				rejected.push(`${mode} (${result.exchange.status})`)
		}
		if (rejected.length === 0) return
		ctx.findings.spec(
			this.id,
			ctx.entityName,
			"a declared search mode is rejected",
			`rejected: ${rejected.join(", ")}.`,
			[],
		)
	},
}

const searchModesDiffer: Check = {
	applicable: (ctx) =>
		conv(ctx).searchMode !== undefined &&
		(resolvedCaps(ctx).searchModes?.length ?? 0) >= 2 &&
		conv(ctx).search !== undefined,
	dependsOn: ["search.mode-accepted"],
	id: "search.modes-differ",
	needs: "at least two declared searchModes and a mode parameter",
	async run(ctx) {
		const modes = resolvedCaps(ctx).searchModes ?? []
		const a = modes[0]
		const b = modes[1]
		if (a === undefined || b === undefined) return
		const field = ctx.query?.searchable[0]
		const token =
			field === undefined
				? "oat"
				: ctx.records
						.map((row) => row[field])
						.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return
		const left = await list(ctx, q(ctx, { limit: 100, search: token, searchMode: a }))
		const right = await list(ctx, q(ctx, { limit: 100, search: token, searchMode: b }))
		if (left.exchange.status >= 400 || right.exchange.status >= 400) return
		if (ids(left.items, ctx.identity).join(",") !== ids(right.items, ctx.identity).join(",")) return
		ctx.findings.unresolved(
			this.id,
			ctx.entityName,
			`modes ${a} and ${b} returned the same set; cannot prove they are distinct implementations`,
		)
	},
}

const selectRequestedFieldsPresent: Check = {
	applicable: (ctx) => conv(ctx).select !== undefined && (ctx.query?.selectable.length ?? 0) > 0,
	dependsOn: ["select.projection-honoured"],
	id: "select.requested-fields-present",
	needs: "a select parameter and at least one selectable field",
	async run(ctx) {
		const requested = [
			ctx.identity,
			...(ctx.query?.selectable.filter((name) => name !== ctx.identity).slice(0, 2) ?? []),
		]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		if (projection === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "select probe was rejected or empty")
		}
		const missing = requested.filter((name) => !Object.hasOwn(result.items[0] as object, name))
		if (missing.length === 0) return
		if (
			missing.length === 1 &&
			missing[0] === ctx.identity &&
			!(ctx.query?.selectable.includes(ctx.identity) ?? false)
		) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "identity was omitted from select and missing from items")
		}
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a requested select field is missing from the projection",
			`select=${requested.join(",")} omitted ${missing.join(", ")}.`,
			[result.exchange],
		)
	},
}

const selectUnknownFieldRejected: Check = {
	applicable: (ctx) => conv(ctx).select !== undefined && resolvedCaps(ctx).select?.unknown !== undefined,
	dependsOn: ["select.projection-honoured", "error.malformed-filter-not-5xx"],
	id: "select.unknown-field-rejected",
	needs: "`select.unknown` declared",
	async run(ctx) {
		const policy = resolvedCaps(ctx).select?.unknown
		if (policy === undefined) return
		const requested = [ctx.identity, "oat_no_such_select_xyz"]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		if (projection === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (policy === "reject") {
			if (result.exchange.status >= 400 && result.exchange.status < 500) return
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown select field was not rejected",
				`select.unknown=reject but the probe returned ${result.exchange.status}.`,
				[result.exchange],
			)
			return
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "unknown select field was rejected under ignore")
		}
		const extras = Object.keys(result.items[0] ?? {}).filter((key) => key === "oat_no_such_select_xyz")
		if (extras.length === 0) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown select field was honoured under ignore",
			"select.unknown=ignore should drop the undeclared name, not return it.",
			[result.exchange],
		)
	},
}

const selectNestedHonoured: Check = {
	applicable: (ctx) =>
		conv(ctx).select !== undefined &&
		resolvedCaps(ctx).select?.nested === true &&
		(resolvedCaps(ctx).select?.relations?.length ?? 0) > 0,
	dependsOn: ["select.projection-honoured"],
	id: "select.nested-honoured",
	needs: "select.nested and a named relation",
	async run(ctx) {
		const relation = resolvedCaps(ctx).select?.relations?.[0]
		if (relation === undefined || relation.fields[0] === undefined) return
		const clause = `${relation.name}(${relation.fields[0]})`
		const projection = selectTerm(conv(ctx), [ctx.identity, clause], ctx.entityName)
		if (projection === null) return
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "nested select was rejected or empty")
		}
		const nested = result.items[0][relation.name]
		if (nested === null || typeof nested !== "object") {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"nested select did not return the relation as an object",
				`select=${clause} left "${relation.name}" as ${typeof nested}.`,
				[result.exchange],
			)
			return
		}
		const keys = Object.keys(nested as object)
		if (keys.every((key) => key === relation.fields[0])) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"nested select did not restrict the relation to the requested field",
			`select=${clause} returned ${keys.join(", ") || "(empty)"}.`,
			[result.exchange],
		)
	},
}

const querySortAndSelectCompose: Check = {
	applicable: (ctx) =>
		conv(ctx).order !== undefined &&
		conv(ctx).select !== undefined &&
		(ctx.query?.sortable.length ?? 0) > 0 &&
		(ctx.query?.selectable.length ?? 0) > 0 &&
		ctx.records.length > 1,
	dependsOn: ["sort.order-is-applied", "select.projection-honoured", "select.requested-fields-present"],
	id: "query.sort-and-select-compose",
	needs: "sortable and selectable fields",
	async run(ctx) {
		const field = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		const extra = ctx.query?.selectable.find((name) => name !== ctx.identity)
		if (field === undefined) return
		const requested = extra === undefined ? [ctx.identity] : [ctx.identity, extra]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		if (projection === null) return
		const result = await list(ctx, {
			...q(ctx, { limit: 20, order: sortTerm(conv(ctx), field, "asc") }),
			...projection,
		})
		if (result.exchange.status >= 400 || result.items.length < 2) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "sort+select probe was rejected")
		}
		const extras = Object.keys(result.items[0] ?? {}).filter((key) => !requested.includes(key))
		const values = result.items.map((item) => item[field])
		const sorted = [...values].sort(compareValues)
		if (extras.length === 0 && JSON.stringify(values) === JSON.stringify(sorted)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"sort and select do not compose",
			extras.length > 0
				? `select leaked ${extras.slice(0, 5).join(", ")}.`
				: `order=${field}.asc did not hold under the projection.`,
			[result.exchange],
		)
	},
}

const querySearchAndSelectCompose: Check = {
	applicable: (ctx) =>
		conv(ctx).search !== undefined &&
		conv(ctx).select !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		(ctx.query?.selectable.length ?? 0) > 0,
	dependsOn: ["search.q-narrows-result", "select.projection-honoured"],
	id: "query.search-and-select-compose",
	needs: "searchable and selectable fields",
	async run(ctx) {
		const field = ctx.query?.searchable[0]
		if (field === undefined) return
		const token = ctx.records
			.map((row) => row[field])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return
		const requested = [ctx.identity, field]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		if (projection === null) return
		const searched = await list(ctx, q(ctx, { limit: 100, search: token }))
		const combined = await list(ctx, { ...q(ctx, { limit: 100, search: token }), ...projection })
		if (searched.exchange.status >= 400 || combined.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+select probe was rejected")
		}
		if (combined.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
		}
		if (sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a select changes which records a search returns",
			`q=${JSON.stringify(token)} alone matched ${searched.items.length}; with select it matched ${combined.items.length}.`,
			[searched.exchange, combined.exchange],
		)
	},
}

const querySearchAndSortCompose: Check = {
	applicable: (ctx) =>
		conv(ctx).search !== undefined &&
		conv(ctx).order !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		(ctx.query?.sortable.length ?? 0) > 0,
	dependsOn: ["search.q-narrows-result", "sort.order-is-applied"],
	id: "query.search-and-sort-compose",
	needs: "searchable and sortable fields",
	async run(ctx) {
		const searchField = ctx.query?.searchable[0]
		const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (searchField === undefined || sortField === undefined) return
		const token = ctx.records
			.map((row) => row[searchField])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return
		const searched = await list(ctx, q(ctx, { limit: 100, search: token }))
		const combined = await list(
			ctx,
			q(ctx, { limit: 100, search: token, order: sortTerm(conv(ctx), sortField, "asc") }),
		)
		if (searched.exchange.status >= 400 || combined.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+sort probe was rejected")
		}
		if (!sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"adding a sort changes which records a search returns",
				`q=${JSON.stringify(token)} membership changed when order=${sortField} was added.`,
				[searched.exchange, combined.exchange],
			)
			return
		}
		const values = combined.items.map((item) => item[sortField])
		const sorted = [...values].sort(compareValues)
		if (JSON.stringify(values) === JSON.stringify(sorted)) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"search results are not ordered",
			`q + order=${sortField}.asc did not keep ${sortField} ascending.`,
			[combined.exchange],
		)
	},
}

const queryFilterSearchSortSelectCompose: Check = {
	applicable: (ctx) =>
		filterable(ctx) &&
		conv(ctx).search !== undefined &&
		conv(ctx).order !== undefined &&
		conv(ctx).select !== undefined &&
		(ctx.query?.searchable.length ?? 0) > 0 &&
		(ctx.query?.sortable.length ?? 0) > 0 &&
		(ctx.query?.selectable.length ?? 0) > 0 &&
		ctx.records.length > 2,
	dependsOn: [
		"query.search-and-filter-compose",
		"query.axes-compose",
		"query.filter-and-select-compose",
		"query.sort-and-select-compose",
		"query.filter-sort-select-compose",
		"query.filter-search-sort-compose",
		"query.filter-search-select-compose",
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-search-sort-select-compose",
	needs: "all four list axes declared and at least three records",
	async run(ctx) {
		const picked = overlappingFilterAndSearch(ctx)
		if (picked === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no overlapping filter/search token")
		}
		const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		const extra = ctx.query?.selectable.find((name) => name !== ctx.identity)
		if (sortField === undefined) return
		const conventions = conv(ctx)
		const term = filterTerm(conventions, picked.field, "eq", String(picked.target[picked.field]))
		if (term === null) return
		const requested = extra === undefined ? [ctx.identity] : [ctx.identity, extra]
		const projection = selectTerm(conventions, requested, ctx.entityName)
		if (projection === null) return
		const base = await collectSet(ctx, ctx.query?.maxLimit ?? 100, {
			...term,
			...(conventions.search === undefined ? {} : { [conventions.search]: picked.token }),
		})
		const combined = await collectSet(
			ctx,
			ctx.query?.maxLimit ?? 100,
			{ ...term, ...projection, ...(conventions.search === undefined ? {} : { [conventions.search]: picked.token }) },
			MAX_WALK_PAGES,
			sortTerm(conventions, sortField, "asc"),
		)
		if (base === null || combined === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "four-axis probe was rejected")
		}
		if (combined.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
		}
		if (sameSet(setOf(base.items, ctx.identity), setOf(combined.items, ctx.identity))) return
		ctx.findings.backend(
			this.id,
			ctx.entityName,
			"filter ∩ search membership changes when sort and select join",
			`the four-axis listing returned ${combined.items.length}; filter+search alone returned ${base.items.length}.`,
			[base.last.exchange, combined.last.exchange],
		)
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
	sortNumericOrderIsNumeric,
	sortNullsFirstLast,
	sortMultiKeyTiebreak,
	sortDefaultOrderApplied,
	sortStableTiebreak,
	pageWalkCoversSet,
	cursorAgreesWithPage,

	/* query semantics */
	unknownFilterRejected,
	malformedFilterNot5xx,
	sortUnknownFieldRejected,
	equalityFilterSelectsOne,
	zeroMatchFilter,
	negationPartitions,
	filterAndComposesAsIntersection,
	filterOrComposesAsUnion,
	filterInIsUnionOfEq,
	filterNinComplementsIn,
	filterNestedAndOrDistributes,
	likeEscaping,
	filterIlikeIsCaseInsensitive,
	filterIsNullSelectsNulls,
	filterContainsMembership,
	sortReverseSymmetry,
	searchNarrowsResult,
	searchTokensAnd,
	searchCaseInsensitive,
	searchEmptyQ,
	searchUndeclaredFieldNotRequired,
	searchModeAccepted,
	searchModesDiffer,
	selectProjection,
	selectRequestedFieldsPresent,
	selectUnknownFieldRejected,
	selectNestedHonoured,
	countIsConsistentWithPage,
	countMatchesWalk,
	numericComparisonIsNumeric,
	filterGteIsGtOrEq,
	filterLteIsLtOrEq,
	filterOrderedTriplePartitions,

	/* write semantics */
	patchMinimality,
	immutableRejected,
	stringPayloadSurvives,
	idempotentReplay,
	declaredInvalidationHappens,
	projectionsAgree,
	queryAxesCompose,
	filterAndPagingCompose,
	filterAndSelectCompose,
	searchAndFilterCompose,
	filterSortSelectCompose,
	filterSearchSortCompose,
	filterSearchSelectCompose,
	querySortAndSelectCompose,
	querySearchAndSelectCompose,
	querySearchAndSortCompose,
	queryFilterSearchSortSelectCompose,
	declaredFilterableWorks,
	declaredFilterableOpsAccepted,
	declaredFilterableIllegalOpRejected,
	declaredSortableWorks,
	declaredSortableNullsAccepted,
	declaredSelectableWorks,
	filterAliasMatchesCanonical,
	filterIllegalOpRejected,
	filterEmptyIn,
	filterInOverLimitRejected,
	filterConditionCapRejected,
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
	rankIsMonotonic,
	inviteGrantsThenRevokes,

	/* declared side effects and async lifecycles, last: both invoke operations that change the
	 * world, and both are meaningless if the read surface above is already known broken */
	declaredEffectsOccur,
	sideEffectArrives,
	asyncReachesTerminalState,
	asyncReceiptIsResolvable,
	/* After every other check has written to the transcript — create is owned by
	 * create.status-matches-document. */
	documentedStatusHonoured,
]
