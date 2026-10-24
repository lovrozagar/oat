/**
 * The checks the matrix draws: the poster's cells in order, the composition edges between them, and
 * every check grouped into the strips the poster lists.
 */

import { entityChecks } from "../../runtime/checks/core/registry.ts"
import { CHECKS } from "../../runtime/checks/registry.ts"
import type { MatrixGraphEdge, MatrixLayer } from "./types.ts"

/** A poster cell: the check it shows, its short label, and what it asks. */
export interface CellSpec {
	id: string
	label: string
	hint: string
}

/** A strip of related checks, the graph group its checks belong to, and the layer that group sits on. */
export interface Strip {
	title: string
	layer: MatrixLayer
	ids: readonly string[]
}

export const NODE_ORDER: readonly CellSpec[] = [
	{ hint: "create then list", id: "list.read-after-write", label: "list" },
	{ hint: "item GET agrees", id: "consistency.projections-agree", label: "item" },
	{ hint: "id.eq selects one", id: "filter.equality-selects-exactly-one", label: "filter" },
	{ hint: "order rearranges", id: "sort.order-is-applied", label: "sort" },
	{ hint: "sparse fieldset", id: "select.projection-honored", label: "select" },
	{ hint: "q narrows", id: "search.q-narrows-result", label: "search" },
	{ hint: "walk covers set", id: "pagination.page-walk-covers-set", label: "page" },
	{ hint: "other tenant 404", id: "tenant.item-not-readable-cross-tenant", label: "tenant" },
	{ hint: "membership unchanged", id: "query.axes-compose", label: "filter + sort" },
	{ hint: "same rows, fewer fields", id: "query.filter-and-select-compose", label: "filter + select" },
	{ hint: "both predicates hold", id: "query.search-and-filter-compose", label: "filter + search" },
	{ hint: "filter before page", id: "query.filter-selects-from-whole-set", label: "filter / page" },
	{ hint: "three axes at once", id: "query.filter-sort-select-compose", label: "filter + sort + select" },
	{ hint: "three axes at once", id: "query.filter-search-sort-compose", label: "filter + search + sort" },
	{ hint: "three axes at once", id: "query.filter-search-select-compose", label: "filter + search + select" },
]

export const USES: ReadonlyArray<{ from: string; to: string }> = [
	{ from: "filter.equality-selects-exactly-one", to: "query.axes-compose" },
	{ from: "sort.order-is-applied", to: "query.axes-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.filter-and-select-compose" },
	{ from: "select.projection-honored", to: "query.filter-and-select-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.search-and-filter-compose" },
	{ from: "search.q-narrows-result", to: "query.search-and-filter-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.filter-selects-from-whole-set" },
	{ from: "pagination.page-walk-covers-set", to: "query.filter-selects-from-whole-set" },
	{ from: "query.axes-compose", to: "query.filter-sort-select-compose" },
	{ from: "query.filter-and-select-compose", to: "query.filter-sort-select-compose" },
	{ from: "query.axes-compose", to: "query.filter-search-sort-compose" },
	{ from: "query.search-and-filter-compose", to: "query.filter-search-sort-compose" },
	{ from: "query.filter-and-select-compose", to: "query.filter-search-select-compose" },
	{ from: "query.search-and-filter-compose", to: "query.filter-search-select-compose" },
]

export const STRIPS: readonly Strip[] = [
	{
		ids: [
			"filter.unknown-field-rejected",
			"filter.equality-selects-exactly-one",
			"filter.zero-match-returns-none",
			"filter.negation-partitions-the-set",
			"filter.and-composes-as-intersection",
			"filter.or-composes-as-union",
			"filter.like-metacharacters-escaped",
			"filter.numeric-comparison-is-numeric",
			"error.malformed-filter-not-5xx",
		],
		layer: "axis",
		title: "filter",
	},
	{ ids: ["sort.order-is-applied", "sort.reverse-symmetry"], layer: "axis", title: "sort" },
	{ ids: ["select.projection-honored"], layer: "axis", title: "select" },
	{ ids: ["search.q-narrows-result"], layer: "axis", title: "search" },
	{
		ids: [
			"pagination.page-walk-covers-set",
			"pagination.cursor-agrees-with-page",
			"pagination.limit-bounds-page-size",
			"pagination.limit-respects-documented-max",
			"pagination.has-more-is-accurate",
			"count.consistent-with-returned-page",
			"count.matches-filtered-set",
		],
		layer: "axis",
		title: "page / count",
	},
	{
		ids: [
			"query.axes-compose",
			"query.filter-and-select-compose",
			"query.search-and-filter-compose",
			"query.filter-selects-from-whole-set",
			"query.filter-sort-select-compose",
			"query.filter-search-sort-compose",
			"query.filter-search-select-compose",
		],
		layer: "composition",
		title: "composition",
	},
	{
		ids: [
			"spec.declared-filterable-is-filterable",
			"spec.declared-sortable-is-sortable",
			"spec.declared-selectable-is-selectable",
		],
		layer: "spec",
		title: "spec promise",
	},
	{
		ids: [
			"tenant.item-not-readable-cross-tenant",
			"tenant.denial-does-not-reveal-existence",
			"tenant.filter-does-not-bypass-scope",
			"auth.rank-is-monotonic",
			"auth.invite-grants-then-revokes",
		],
		layer: "auth",
		title: "who may see it",
	},
	{
		ids: [
			"list.read-after-write",
			"create.persists-submitted-fields",
			"payload.string-survives",
			"create.status-matches-document",
			"response.status-is-documented",
			"consistency.projections-agree",
			"softdelete.absent-from-default-list",
			"invalidation.declared-route-changes",
			"patch.minimality",
			"patch.immutable-field-rejected",
			"idempotency.replay-does-not-duplicate",
			"delete.absent-record-returns-404",
			"concurrency.no-lost-update",
			"effects.declared-effect-occurs",
			"async.reaches-terminal-state",
			"async.receipt-identifies-the-job",
		],
		layer: "surface",
		title: "write / surface",
	},
	{
		ids: [
			"validation.enum-enforced",
			"validation.max-length-enforced",
			"validation.required-enforced",
			"validation.content-type-enforced",
			"schema.success-response-matches-document",
			"schema.error-response-matches-document",
		],
		layer: "schema",
		title: "schema",
	},
]

/** The cataloged checks, each with its strip, what it needs, and the edges between them. */
export interface CheckCatalog {
	/** Every check id the matrix tracks, in strip order. */
	ids: readonly string[]
	stripOf: ReadonlyMap<string, Strip>
	needs: ReadonlyMap<string, string | undefined>
	edges: MatrixGraphEdge[]
}

export function checkCatalog(): CheckCatalog {
	const stripOf = new Map(STRIPS.flatMap((strip) => strip.ids.map((id) => [id, strip] as const)))
	return {
		edges: [
			...entityChecks(CHECKS).flatMap((check) =>
				(check.dependsOn ?? []).map((dep): MatrixGraphEdge => ({ from: dep, kind: "dependsOn", to: check.id })),
			),
			...USES.map((use): MatrixGraphEdge => ({ ...use, kind: "uses" })),
		],
		ids: [...stripOf.keys()],
		needs: new Map(CHECKS.map((check) => [check.id, check.needs])),
		stripOf,
	}
}
