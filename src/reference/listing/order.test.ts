import { describe, expect, it } from "vitest"
import type { DefectName } from "../defects/table.ts"
import { TABLE } from "../model/table.ts"
import type { EntityDef } from "../model/types.ts"
import { parseContext } from "./__fixtures__/store.ts"
import type { Axes } from "./axes.ts"
import { listingOrder } from "./order.ts"
import type { ListingRequest } from "./types.ts"

const NONE: Axes = { searched: false, selected: false, sorted: false }
const SELECTED: Axes = { ...NONE, selected: true }
const order = (request: ListingRequest, defects: DefectName[] = [], axes = NONE, entity: EntityDef = TABLE) =>
	listingOrder(request, parseContext(defects, entity), axes)
const fields = (request: ListingRequest, defects: DefectName[] = [], axes = NONE) =>
	order(request, defects, axes).fullOrder.map((term) => `${term.field}${term.descending ? "-" : "+"}`)

describe("listingOrder: the order chosen", () => {
	it("takes the named order, or the documented default, with the identity as the last tiebreak", () => {
		expect(fields({})).toEqual(["created_at-", "id+"])
		expect(fields({ order: "" })).toEqual(["created_at-", "id+"])
		expect(fields({ order: "name,position.desc" })).toEqual(["name+", "position-", "id+"])
	})

	it("forgets the default, ignores the order, or drops it once a select joins, under the defects", () => {
		expect(fields({}, ["DEFAULT_ORDER_IGNORED"])).toEqual(["id+"])
		expect(fields({ order: "name" }, ["ORDER_IGNORED"])).toEqual(["created_at-", "id+"])
		expect(fields({ order: "name" }, ["ORDER_DROPPED_WHEN_SELECTED"], SELECTED)).toEqual(["created_at-", "id+"])
		expect(fields({ order: "name" }, ["ORDER_DROPPED_WHEN_SELECTED"])).toEqual(["name+", "id+"])
		expect(fields({}, ["ORDER_DROPPED_WHEN_SELECTED"], SELECTED)).toEqual(["created_at-", "id+"])
	})

	it("refuses an order a correct backend refuses", () => {
		expect(() => order({ order: "nosuch" })).toThrow('field "nosuch" is not sortable')
	})
})

describe("listingOrder: what the order changes", () => {
	it("keeps rows with a null descending key out, under the defect", () => {
		expect(order({ order: "name,position.desc" }, ["SORT_DESC_DROPS_NULLS"]).dropNulls).toEqual([
			{ field: "position", kind: "isnull", negate: true },
		])
		expect(order({ order: "position.desc" }).dropNulls).toEqual([])
	})

	it("adds no tiebreak to an unstable sort", () => {
		expect(order({ order: "name" }, ["UNSTABLE_SORT"])).toMatchObject({
			fullOrder: [{ field: "name" }],
			unstable: true,
		})
		expect(order({}).unstable).toBe(false)
	})

	it("breaks ties by the first searchable text field under the defect, where the entity has one", () => {
		expect(fields({}, ["TIEBREAK_NOT_APPLIED"])).toEqual(["created_at-", "name+", "id+"])
		expect(order({}, ["TIEBREAK_NOT_APPLIED"]).fullOrder[1]).toEqual({
			asText: true,
			descending: false,
			field: "name",
			nullsFirst: false,
		})
		const plain = { ...TABLE, fields: TABLE.fields.map((field) => ({ ...field, searchable: false })) }
		expect(order({}, ["TIEBREAK_NOT_APPLIED"], NONE, plain).fullOrder.map((term) => term.field)).toEqual([
			"created_at",
			"id",
		])
	})
})
