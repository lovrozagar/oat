import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { DEFAULT_CONVENTIONS } from "../query/conventions.ts"
import type { Row } from "../store-api.ts"
import { recording, seededStore } from "./__fixtures__/store.ts"
import { runListing } from "./run.ts"
import type { ListingOptions, ListingRequest } from "./types.ts"

const OPTIONS: ListingOptions = { conventions: DEFAULT_CONVENTIONS, scope: { project_id: "proj_alpha" } }

const embed = async (relation: string, row: Row) => ({ name: `${relation}:${String(row["id"])}` })

const transform = (row: Row): Row => ({ ...row, name: String(row["name"]).toUpperCase() })

async function list(request: ListingRequest, defects: DefectName[] = [], options: Partial<ListingOptions> = {}) {
	const { plans, store } = recording(await seededStore())
	const result = await runListing(store, {
		defects: new DefectSet(defects),
		entity: TABLE,
		options: { ...OPTIONS, ...options },
		request,
	})
	return { ids: result.items.map((item) => item["id"]), plans, result }
}

describe("runListing: a page", () => {
	it("serves the tenant's live rows in the default order, with the facts of the page", async () => {
		const { ids, plans, result } = await list({ limit: "2" })
		expect(ids).toEqual(["t6", "t5"])
		expect(result).toMatchObject({ count: 5, hasMore: true, limit: 2, offset: 0, page: 1 })
		expect(typeof result.nextCursor).toBe("string")
		expect(plans).toHaveLength(1)
		expect(plans[0]).toMatchObject({ collation: "binary", shuffleTies: false })
	})

	it("continues after the cursor's row, with no page number, and ends with no next cursor", async () => {
		const first = await list({ limit: "2" })
		const next = await list({ cursor: first.result.nextCursor ?? "", limit: "2" })
		expect(next.ids).toEqual(["t4", "t2"])
		expect(next.result).toMatchObject({ offset: 2, page: null })
		const last = await list({ limit: "2", offset: "4" })
		expect(last.ids).toEqual(["t1"])
		expect(last.result).toMatchObject({ hasMore: false, nextCursor: null, offset: 4, page: null })
	})

	it("refuses a cursor it never issued", async () => {
		await expect(list({ cursor: "bogus" })).rejects.toThrow("cursor is not a value produced by this API")
	})

	it("transforms each served row before projecting it, and embeds through the options", async () => {
		const { result } = await list({ limit: "1", select: "name" }, [], { embed, transform })
		expect(result.items).toEqual([{ name: "ZETA" }])
		const rows = await runListing(recording(await seededStore([{ id: "r1", table_id: "t1" }], ROW)).store, {
			defects: new DefectSet(),
			entity: ROW,
			options: { conventions: DEFAULT_CONVENTIONS, embed, scope: {} },
			request: { select: "id,table(name)" },
		})
		expect(rows.items).toEqual([{ id: "r1", table: { name: "table:r1" } }])
	})
})

describe("runListing: counting and the empty-result guard", () => {
	it("counts what matches, zero under one defect and everything under the other", async () => {
		expect((await list({ filter: "status.eq.active" })).result.count).toBe(2)
		expect((await list({ filter: "status.eq.active" }, ["COUNT_ALWAYS_ZERO"])).result.count).toBe(0)
		const ignored = await list({ filter: "status.eq.active" }, ["COUNT_IGNORES_FILTER"])
		expect(ignored.result.count).toBe(5)
		expect(ignored.plans).toHaveLength(2)
	})

	it("falls back to every row when a filter or search matches none, under the guard", async () => {
		const filtered = await list({ filter: "name.eq.nothing" }, ["EMPTY_RESULT_RETURNS_ALL"])
		expect(filtered.ids).toHaveLength(5)
		expect(filtered.plans).toHaveLength(2)
		expect((await list({ q: "nothing" }, ["EMPTY_RESULT_RETURNS_ALL"])).ids).toHaveLength(5)
		expect((await list({ filter: "name.eq.nothing" })).ids).toEqual([])
		expect((await list({}, ["EMPTY_RESULT_RETURNS_ALL"], { scope: { project_id: "proj_none" } })).plans).toHaveLength(1)
	})

	it("says there is no next page under the defect", async () => {
		expect((await list({ limit: "1" }, ["HASMORE_ALWAYS_FALSE"])).result).toMatchObject({
			hasMore: false,
			nextCursor: null,
		})
	})
})

describe("runListing: defects in the window", () => {
	it("resolves the cursor under the other collation, under the defect", async () => {
		const first = await list({ limit: "2", order: "name" })
		const next = await list({ cursor: first.result.nextCursor ?? "", limit: "2", order: "name" }, [
			"COLLATION_INCONSISTENT",
		])
		expect(next.plans.map((plan) => plan.collation)).toEqual(["binary", "insensitive"])
		/* Binary order puts t4 second; the insensitive one puts it third, so the page starts one row late. */
		expect(next.result.offset).toBe(3)
	})

	it("cuts the window before filtering, under the defect, and hands out no cursor past an empty page", async () => {
		const paged = await list({ filter: "status.eq.draft", limit: "2" }, ["FILTER_AFTER_PAGINATION"])
		expect(paged.ids).toEqual(["t6"])
		expect(paged.plans).toHaveLength(2)
		expect(paged.plans[0]?.where).not.toEqual(paged.plans[1]?.where)
		const empty = await list({ filter: "status.eq.archived", limit: "1" }, ["FILTER_AFTER_PAGINATION"])
		expect(empty.result).toMatchObject({ hasMore: true, items: [], nextCursor: null })
	})

	it("shuffles ties and drops the tiebreak, under the unstable sort", async () => {
		const { plans } = await list({ order: "status" }, ["UNSTABLE_SORT"])
		expect(plans[0]).toMatchObject({ order: [{ field: "status" }], shuffleTies: true })
	})
})
