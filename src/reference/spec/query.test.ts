import { describe, expect, it } from "vitest"
import { CLASSIC, POSTGREST, TEMPLATE } from "../dialect/presets.ts"
import { ENTITIES } from "../model/entities.ts"
import type { EntityDef } from "../model/types.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { queryDeclaration } from "./query.ts"

const CTX = { entities: ENTITIES, shape: {} }

function rows(value: unknown): Array<Record<string, unknown>> {
	return value as Array<Record<string, unknown>>
}

describe("queryDeclaration without a catalog", () => {
	const query = queryDeclaration(CTX, JOB, POSTGREST)

	it("lists filterable and sortable fields by name", () => {
		expect(query.filterable).toEqual(JOB.fields.filter((f) => f.filterable === true).map((f) => f.name))
		expect(query.sortable).toEqual(JOB.fields.filter((f) => f.sortable === true).map((f) => f.name))
		expect(query.selectable).toEqual(JOB.fields.map((f) => f.name))
	})

	it("states the grammar, the limits, the tiebreak and the search semantics", () => {
		expect(query).toMatchObject({
			grammar: "postgrest",
			limitOutOfRange: "reject",
			maxLimit: JOB.maxLimit,
			searchCase: "insensitive",
			searchEmpty: "match-all",
			searchModes: ["contains", "prefix"],
			stableTiebreak: "id",
		})
		expect(query).not.toHaveProperty("aliases")
		expect(query).not.toHaveProperty("select")
		expect(query).not.toHaveProperty("sortGrammar")
	})

	it("spells the default order in the dialect's sort grammar", () => {
		expect((query.sort as { defaultOrder: string }).defaultOrder).toMatch(/\./)
		expect(queryDeclaration(CTX, JOB, CLASSIC)).not.toHaveProperty("searchModes")
	})
})

describe("queryDeclaration with a catalog", () => {
	const query = queryDeclaration(CTX, TABLE, POSTGREST)

	it("declares each filterable field's operators and query type", () => {
		const byField = new Map(rows(query.filterable).map((row) => [row.field, row]))
		expect(byField.get("status")).toEqual({ field: "status", ops: ["eq", "neq", "in", "nin"], type: "enum" })
		expect(byField.get("position")).toMatchObject({ type: "number" })
		expect(byField.get("name")).toMatchObject({ type: "string" })
	})

	it("declares each sortable field's type and null placement", () => {
		const byField = new Map(rows(query.sortable).map((row) => [row.field, row]))
		expect(byField.get("name")).toEqual({ field: "name", nulls: ["first", "last"], type: "string" })
	})

	it("declares the catalog's limits", () => {
		expect(query).toMatchObject({
			aliases: { ne: "neq" },
			emptyIn: "match-none",
			maxFilterConditions: 20,
			maxInValues: 100,
			maxSortKeys: 3,
			selectUnknown: "reject",
			sortNulls: ["first", "last"],
		})
	})

	it("types only fields with a query type, and lists names when no operators are given", () => {
		const odd: EntityDef = {
			...TABLE,
			fields: [
				...TABLE.fields,
				{ name: "flag", sortable: true, type: "boolean" },
				{ name: "blob", sortable: true, type: "object" },
			],
			filterCatalog: { opsByField: { flag: ["eq"], ghost: ["eq"] } },
		}
		const declared = queryDeclaration(CTX, odd, POSTGREST)
		expect(rows(declared.filterable)).toEqual([
			{ field: "flag", ops: ["eq"], type: "boolean" },
			{ field: "ghost", ops: ["eq"] },
		])
		const sortable = new Map(rows(declared.sortable).map((row) => [row.field, row]))
		expect(sortable.get("blob")).toEqual({ field: "blob", nulls: ["first", "last"] })
		expect(declared.aliases).toEqual({})
		const bare = queryDeclaration(CTX, { ...TABLE, filterCatalog: {} }, POSTGREST)
		expect(bare.filterable).toEqual(TABLE.fields.filter((f) => f.filterable === true).map((f) => f.name))
	})
})

describe("queryDeclaration per dialect and shape", () => {
	it("declares the template grammars a dialect carries", () => {
		const query = queryDeclaration(CTX, TABLE, TEMPLATE)
		expect(query.grammar).toEqual(TEMPLATE.filterTemplate)
		expect(query.sortGrammar).toEqual(TEMPLATE.sortTemplate)
	})

	it("says a clamped page size is clamped", () => {
		expect(queryDeclaration({ entities: ENTITIES, shape: { clampLimit: 3 } }, TABLE, POSTGREST).limitOutOfRange).toBe(
			"clamp",
		)
	})

	it("declares nested selection of a related record", () => {
		expect(queryDeclaration(CTX, ROW, POSTGREST).select).toEqual({
			nested: true,
			relations: [{ fields: ["name", "status"], name: "table" }],
		})
	})
})
