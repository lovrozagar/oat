import { canWriteFilterOp, filterSpec } from "../../../spec/conventions/filter.ts"
import type { QueryConventions } from "../../../spec/conventions/types.ts"
import { documentedPage } from "../../../spec/graph/paging.ts"
import type { EffectiveFilterField, EffectiveQueryCapabilities } from "../../../spec/query/effective.ts"
import { fieldAllows } from "../../../spec/query/field-ops.ts"
import { mergeQueryCapabilities } from "../../../spec/query/merge.ts"
import { FILTER_OPS } from "../../../spec/query/ops.ts"
import type { SortValue } from "../../../spec/render/sort.ts"
import type { RequestOptions } from "../../../client/types.ts"
import type { CheckContext } from "../core/context.ts"

/** The list endpoint's derived conventions — parameter roles and envelope spellings. */
export function conv(ctx: CheckContext) {
	return ctx.listOp.conventions
}

/** Query parameters as the client sends them; an array value repeats its parameter. */
export type Query = NonNullable<RequestOptions["query"]>

/**
 * Builds a query using whatever this endpoint actually calls each role.
 *
 * `{ limit: 2, page: 1 }` becomes `?per_page=2&page_number=1` where that is how the document
 * spells them, so a check written once works against an API that shares no parameter names with
 * the fixture.
 */
export function q(ctx: CheckContext, roles: QueryRoles): Query {
	const c = conv(ctx)
	const out: QueryOut = {}
	/* Never above the documented maximum: a backend is right to refuse a request that breaks the
	 * contract, and reading that refusal as anything about the backend would be oat's own fault.
	 * The one check that probes past the cap on purpose sets the parameter itself. */
	const size = roles.limit === undefined ? undefined : Math.min(roles.limit, pageSize(ctx))
	if (size !== undefined && c.limit !== undefined) out[c.limit] = size
	placePage(out, c, roles.page, size)
	for (const role of NAMED_ROLES) {
		const name = c[role]
		const value = roles[role]
		if (value !== undefined && name !== undefined) out[name] = value
	}
	return out
}

/** The roles a check asks for, by what they mean rather than what this endpoint calls them. */
export interface QueryRoles {
	limit?: number | undefined
	page?: number | undefined
	cursor?: string | undefined
	order?: SortValue | undefined
	search?: string | undefined
	searchMode?: string | undefined
	filter?: string | undefined
}

type QueryOut = Record<string, string | number | readonly (string | number)[] | undefined>

/* The roles written as given under the endpoint's own name for each, in this order. */
const NAMED_ROLES = ["cursor", "order", "search", "searchMode", "filter"] as const

/** Writes the page number, or the offset it stands for where the endpoint skips rows instead. */
function placePage(out: QueryOut, c: QueryConventions, page: number | undefined, size: number | undefined): void {
	if (page === undefined) return
	if (c.page !== undefined) out[c.page] = page
	else if (c.offset !== undefined) {
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
		out[c.offset] = Math.max(page - 1, 0) * (size ?? 20)
	}
}

/** The largest page this endpoint documents — see `documentedPage`. */
export function pageSize(ctx: CheckContext): number {
	return documentedPage(ctx.model, ctx.listOp).size
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
export function filterable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	if (c.filter !== undefined) return true
	/* Equality-per-field needs a field to attach the predicate to, and the document has to say
	 * which fields are filterable — otherwise oat would be guessing at parameter names. */
	return filterSpec(c).param === "field" && (ctx.query?.filterable.length ?? 0) > 0
}

export function resolvedCaps(ctx: CheckContext): EffectiveQueryCapabilities {
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

export function filterableNames(ctx: CheckContext): string[] {
	return resolvedCaps(ctx).filterable.map((field) => field.field)
}

/** Filter field for identity predicates when it differs from the JSON identity. */
export function filterIdentity(ctx: CheckContext): string {
	return resolvedCaps(ctx).identityFilter ?? ctx.identity
}

export function identityIsFilterable(ctx: CheckContext): boolean {
	const names = filterableNames(ctx)
	return names.includes(filterIdentity(ctx)) || names.includes(ctx.identity)
}

export function canUseOp(ctx: CheckContext, field: EffectiveFilterField, op: (typeof FILTER_OPS)[number]): boolean {
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
export function pageable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	return c.page !== undefined || c.offset !== undefined
}

export const MOVING_FILTER =
	"the collection gained or lost rows between the term reads and the combined read (something wrote " +
	"to it while the check ran), so the reads cannot be compared"

export const MOVING =
	"the collection gained or lost rows between two reads in the same direction (something wrote to it " +
	"while the check ran), so the reads cannot be compared"

export function asTermValue(value: unknown): string | number {
	return typeof value === "number" ? value : String(value)
}

export const FOUNDATIONS = [
	"list.read-after-write",
	"create.persists-submitted-fields",
	"pagination.page-walk-covers-set",
] as const

/** The JSON type the item schema gives a property, looking through a nullable union. */
export function schemaType(ctx: CheckContext, field: string): string | undefined {
	const properties = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
	const propertySchema = properties[field]
	if (propertySchema === undefined) return undefined
	const branches = [
		propertySchema,
		...((propertySchema.oneOf ?? propertySchema.anyOf ?? []) as Array<Record<string, unknown>>),
	]
	for (const branch of branches) {
		const type = branch.type
		if (typeof type === "string" && type !== "null") return type
		if (Array.isArray(type)) {
			const named = type.find((item) => item !== "null")
			if (typeof named === "string") return named
		}
	}
	return undefined
}
