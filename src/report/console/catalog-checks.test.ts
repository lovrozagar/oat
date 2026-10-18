import { describe, expect, it } from "vitest"
import type { QueryConventions } from "../../spec/conventions/types.ts"
import type { EffectiveQueryCapabilities } from "../../spec/query/effective.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { catalogCheckPreview } from "./catalog-checks.ts"
import { listOperation } from "./describe.ts"

const caps = (over: Partial<EffectiveQueryCapabilities> = {}): EffectiveQueryCapabilities => ({
	aliases: {},
	filterable: [],
	hook: false,
	searchable: [],
	selectable: [],
	sortable: [],
	source: "config",
	...over,
})

const ALL_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "like", "ilike", "is", "contains"] as const

/** `conventions` without the parameters named. */
function without(
	conventions: QueryConventions,
	...keys: Array<"order" | "search" | "select" | "searchMode">
): QueryConventions {
	const copy = { ...conventions }
	for (const key of keys) delete copy[key]
	return copy
}

/** Every declared-or-skip query check, in the order the catalog lists them. */
const EVERY_CHECK = [
	"filter.in-is-union-of-eq",
	"filter.nin-complements-in",
	"filter.gte-is-gt-or-eq",
	"filter.lte-is-lt-or-eq",
	"filter.ordered-triple-partitions",
	"filter.ilike-is-case-insensitive",
	"filter.is-null-selects-nulls",
	"filter.contains-membership",
	"filter.nested-and-or-distributes",
	"filter.alias-matches-canonical",
	"filter.illegal-op-rejected",
	"spec.declared-filterable-ops-accepted",
	"filter.empty-in",
	"filter.in-over-limit-rejected",
	"filter.condition-cap-rejected",
	"sort.unknown-field-rejected",
	"sort.numeric-order-is-numeric",
	"sort.nulls-first-last",
	"spec.declared-sortable-nulls-accepted",
	"sort.multi-key-tiebreak",
	"sort.default-order-applied",
	"sort.stable-tiebreak",
	"search.tokens-and",
	"search.case-insensitive",
	"search.empty-q",
	"search.mode-accepted",
	"select.requested-fields-present",
	"select.unknown-field-rejected",
	"select.nested-honoured",
	"query.sort-and-select-compose",
	"query.search-and-select-compose",
	"query.search-and-sort-compose",
	"query.filter-search-sort-select-compose",
]

/* PostgREST writes every operator and composes and/or; the template dialect writes fewer. */
async function conventionsOf(dialect?: string): Promise<QueryConventions> {
	const { model } = await referenceModel(dialect === undefined ? {} : { dialect })
	return listOperation(model, "table.list").conventions
}

describe("catalogCheckPreview with all or nothing declared", () => {
	it("applies nothing with no capabilities beyond what the parameters alone allow", async () => {
		const conventions = await conventionsOf()
		/* An order parameter alone lets oat ask for a field that is not there. */
		expect(catalogCheckPreview(caps(), { conventions }, "config")).toEqual(["sort.unknown-field-rejected"])
		const bare = without(conventions, "order", "search", "select")
		expect(catalogCheckPreview(caps({ sortable: [{ field: "a" }] }), { conventions: bare }, "config")).toEqual([])
	})

	it("applies every check when every capability is declared and the grammar writes it all, in catalog order", async () => {
		const conventions = await conventionsOf()
		const full = caps({
			aliases: { neq: "ne" },
			emptyIn: "reject",
			filterable: [
				{ field: "a", ops: [...ALL_OPS], type: "string" },
				{ field: "b", ops: ["eq"], type: "number" },
			],
			maxFilterConditions: 5,
			maxInValues: 10,
			searchable: ["a"],
			searchEmpty: "ignore",
			searchModes: ["plain"],
			select: { nested: true, relations: [{ fields: ["x"], name: "r" }], unknown: "reject" },
			selectable: ["a", "b"],
			sort: { defaultOrder: "a", maxKeys: 2, stableTiebreak: "id" },
			sortable: [
				{ field: "a", nulls: ["first", "last"], type: "number" },
				{ field: "b", type: "string" },
			],
		})
		expect(catalogCheckPreview(full, { conventions: { ...conventions, searchMode: "mode" } }, "tag")).toEqual(
			EVERY_CHECK,
		)
		const mixed = catalogCheckPreview(full, { conventions: without(conventions, "searchMode") }, "mixed")
		expect(mixed).toContain("spec.declared-filterable-ops-accepted")
		expect(mixed).not.toContain("search.mode-accepted")
	})
})

describe("catalogCheckPreview with some capabilities held back", () => {
	it("holds back what the grammar cannot write, or what one field alone cannot exercise", async () => {
		const conventions = await conventionsOf("template")
		const preview = catalogCheckPreview(
			caps({
				emptyIn: "reject",
				filterable: [{ field: "a", ops: [...ALL_OPS] }],
				maxFilterConditions: 5,
				maxInValues: 10,
			}),
			{ conventions },
			"config",
		)
		expect(preview).toContain("filter.in-is-union-of-eq")
		expect(preview).not.toContain("filter.nin-complements-in")
		expect(preview).not.toContain("filter.nested-and-or-distributes")
		expect(preview).not.toContain("spec.declared-filterable-ops-accepted")
		expect(preview).toContain("filter.empty-in")
	})

	it("leaves out the limits nobody declared, and the in-list ones when `in` cannot be sent", async () => {
		const conventions = await conventionsOf()
		const preview = catalogCheckPreview(
			caps({
				emptyIn: "reject",
				filterable: [{ field: "a", ops: ["eq"] }],
				maxInValues: 3,
				searchable: ["a"],
				select: { nested: true },
				selectable: ["a"],
				sort: { maxKeys: 1 },
				sortable: [
					{ field: "a", type: "string" },
					{ field: "b", type: "string" },
				],
			}),
			{ conventions },
			"heuristic",
		)
		expect(preview).toEqual([
			"filter.illegal-op-rejected",
			"sort.unknown-field-rejected",
			"search.tokens-and",
			"search.case-insensitive",
			"select.requested-fields-present",
			"query.sort-and-select-compose",
			"query.search-and-select-compose",
			"query.search-and-sort-compose",
			"query.filter-search-sort-select-compose",
		])
	})

	it("needs a grammar that can group conditions before it probes the condition cap", async () => {
		const conventions = await conventionsOf("plain")
		const preview = catalogCheckPreview(caps({ maxFilterConditions: 2 }), { conventions }, "config")
		expect(preview).not.toContain("filter.condition-cap-rejected")
	})
})

describe("catalogCheckPreview on sort keys and nested selects", () => {
	it("judges multi-key sorting only where two keys are allowed, and nested selects only with relations", async () => {
		const conventions = await conventionsOf()
		const two = [{ field: "a" }, { field: "b" }]
		expect(catalogCheckPreview(caps({ sortable: two }), { conventions }, "config")).toContain("sort.multi-key-tiebreak")
		expect(catalogCheckPreview(caps({ sort: {}, sortable: two }), { conventions }, "config")).toContain(
			"sort.multi-key-tiebreak",
		)
		const nested = caps({ select: { nested: true, relations: [] }, selectable: ["a"] })
		expect(catalogCheckPreview(nested, { conventions }, "config")).not.toContain("select.nested-honoured")
	})
})
