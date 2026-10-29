import { describe, expect, it } from "vitest"
import type { Check } from "../../core/check.ts"
import { searchEmptyQ } from "../search-select/search-empty-q.ts"
import { searchTokensAnd } from "../search-select/search-tokens-and.ts"
import { MOVES, moving } from "./__fixtures__/moving.ts"
import { PAGED } from "./__fixtures__/composition-a.ts"
import { queryDoc, stage } from "./__fixtures__/query-api.ts"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import { negationPartitions } from "../filter/filter-negation-partitions-the-set.ts"
import { queryAxesCompose } from "./query-axes-compose.ts"
import { filterAndSelectCompose } from "./query-filter-and-select-compose.ts"
import { filterSearchSelectCompose } from "./query-filter-search-select-compose.ts"
import { filterSearchSortCompose } from "./query-filter-search-sort-compose.ts"
import { filterAndPagingCompose } from "./query-filter-selects-from-whole-set.ts"
import { filterSortSelectCompose } from "./query-filter-sort-select-compose.ts"
import { searchAndFilterCompose } from "./query-search-and-filter-compose.ts"
import { querySearchAndSelectCompose } from "./query-search-and-select-compose.ts"

/*
 * Lanes run side by side, and an entity in another lane can write to the collection a query check
 * reads term by term. A full prod run read q="Oat", q="Quarterly" and a filter, then another entity
 * created a template matching "Quarterly Report 0", and the next reads held it: tokens-and and
 * search-and-filter-compose each reported the combination one record off its intersection. A
 * check that compares several reads must read again before blaming the backend.
 */

const CHECKS = [
	searchTokensAnd,
	searchEmptyQ,
	searchAndFilterCompose,
	querySearchAndSelectCompose,
	filterSearchSelectCompose,
	filterAndSelectCompose,
	filterSortSelectCompose,
	filterSearchSortCompose,
	queryAxesCompose,
	filterAndPagingCompose,
	negationPartitions,
] as Check[]

/* The checks that plan only on a paged listing, a declared empty-q policy, or a filterable identity. */
const DOCS = new Map<Check, OpenApiDocument>([
	[searchEmptyQ as Check, queryDoc({ searchEmpty: "match-all" })],
	[filterAndPagingCompose as Check, PAGED],
	[negationPartitions as Check, queryDoc({ filterable: ["id", "title", "status", "rank"] })],
])

async function judge(check: Check, after: number, move: (typeof MOVES)[number]): Promise<string[]> {
	const doc = DOCS.get(check)
	const staged = stage(check, { ...(doc === undefined ? {} : { doc }), respond: moving(after, move) })
	/* A check that never plans proves nothing about its reads. */
	expect(staged.plan()).toMatchObject({ ok: true })
	await staged.run()
	return staged.findings.findings.filter((f) => f.verdict === "BACKEND_BUG").map((f) => `${f.check}: ${f.summary}`)
}

describe("a query check whose collection moves between its reads", () => {
	for (const check of CHECKS) {
		for (const move of MOVES) {
			for (const after of [1, 2, 3]) {
				it(`${check.id} blames nothing on the backend after a ${move} following read ${after}`, async () => {
					expect(await judge(check, after, move)).toEqual([])
				})
			}
		}
	}

	it("search.tokens-and is unresolved, not failed, when a matching record lands between its token reads", async () => {
		const staged = stage(searchTokensAnd, { respond: moving(2, "create") })
		expect(await staged.run()).toMatchObject({ kind: "unresolved" })
		expect(staged.findings.inconclusive[0]?.reason).toContain("gained or lost rows")
	})
})
