import { describe, expect, it } from "vitest"
import { CLASSIC, JSONAPI, LINKED, PLAIN, POSTGREST, TEMPLATE } from "../dialect/presets.ts"
import type { Dialect } from "../dialect/types.ts"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import { listQueryParams, pathParams, renderOrder, tenantParam } from "./params.ts"

const SPACED: Dialect = { ...POSTGREST, sortGrammar: "spaced" }

function names(dialect: Dialect): string[] {
	return listQueryParams(dialect, TABLE).map(([name]) => name)
}

function description(dialect: Dialect, name: string): string | undefined {
	return listQueryParams(dialect, TABLE).find(([candidate]) => candidate === name)?.[2]
}

function rowIdSchemas(shape: ReferenceShape): unknown[] {
	return pathParams({ entities: shapedEntities(shape), shape }, ROW, true).map((param) => param["schema"])
}

describe("pathParams", () => {
	it("names the parents, marks the project as the root, and adds the item when asked", () => {
		const ctx = { entities: ENTITIES, shape: {} }
		expect(pathParams(ctx, ROW, false).map((param) => param["name"])).toEqual(["project_id", "table_id"])
		expect(pathParams(ctx, ROW, true).map((param) => param["name"])).toEqual(["project_id", "table_id", "row_id"])
		expect(pathParams(ctx, ROW, true).map((param) => param["x-root"])).toEqual([true, undefined, undefined])
	})

	it("types an identifier by the identity it names", () => {
		expect(rowIdSchemas({ ids: "integer" })).toEqual([
			{ type: "string" },
			{ minimum: 1, type: "integer" },
			{ minimum: 1, type: "integer" },
		])
		expect(rowIdSchemas({ ids: "uuid" })[1]).toEqual({ format: "uuid", type: "string" })
		expect(rowIdSchemas({})[1]).toEqual({ type: "string" })
	})

	it("documents every identifier as a bare string under bare id params", () => {
		expect(rowIdSchemas({ bareIdParams: true, ids: "integer" })).toEqual([
			{ type: "string" },
			{ type: "string" },
			{ type: "string" },
		])
	})
})

describe("tenantParam", () => {
	it("is the first parent, or the project when there is none", () => {
		expect(tenantParam(ROW)).toBe("project_id")
		expect(tenantParam({ ...JOB, parents: ["table_id"] })).toBe("table_id")
		expect(tenantParam({ ...JOB, parents: [] })).toBe("project_id")
	})
})

describe("listQueryParams", () => {
	it("declares one filter expression parameter in the dialect's grammar", () => {
		expect(description(POSTGREST, POSTGREST.params.filter)).toMatch(/^PostgREST-style/)
		expect(description(TEMPLATE, TEMPLATE.params.filter)).toMatch(/^One filter term per parameter/)
		expect(description(CLASSIC, CLASSIC.params.filter)).toMatch(/^Filter expression: field=op:value/)
	})

	it("declares one parameter per filterable field under the equality grammar", () => {
		const params = listQueryParams(PLAIN, TABLE)
		expect(params.map(([name]) => name)).not.toContain(PLAIN.params.filter)
		const byName = new Map(params.map(([name, schema]) => [name, schema]))
		expect(byName.get("status")).toEqual({ enum: TABLE.fields.find((f) => f.name === "status")?.enum, type: "string" })
		expect(byName.get("position")).toEqual({ type: "number" })
		expect(byName.get("name")).toEqual({ type: "string" })
		expect(byName.get("amount")).toBeUndefined()
		expect(new Map(listQueryParams(PLAIN, ROW).map(([name, schema]) => [name, schema])).get("amount")).toEqual({
			type: "number",
		})
	})

	it("describes the sort in the dialect's own grammar", () => {
		expect(description(POSTGREST, POSTGREST.params.order)).toMatch(/nullsfirst/)
		expect(description(JSONAPI, JSONAPI.params.order)).toMatch(/prefix with -/)
		expect(description(PLAIN, PLAIN.params.order)).toMatch(/field:asc/)
		expect(description(SPACED, SPACED.params.order)).toMatch(/field asc/)
		expect(description(TEMPLATE, TEMPLATE.params.order)).toMatch(/field_ascending/)
	})

	it("names the sparse fieldset per entity under the bracketed grammar", () => {
		expect(names(JSONAPI)).toContain(`${JSONAPI.params.select}[table]`)
		expect(names(POSTGREST)).toContain(POSTGREST.params.select)
	})

	it("declares a search mode only where the dialect has one", () => {
		expect(names(POSTGREST)).toContain(POSTGREST.params.searchMode)
		const modes = listQueryParams(CLASSIC, TABLE).filter(([, , text]) => text.startsWith("How the search term"))
		expect(modes).toEqual([])
	})

	it("publishes exactly the paging parameters the dialect has", () => {
		expect(names(LINKED)).toContain(LINKED.params.offset)
		expect(names(LINKED)).not.toContain("page")
		expect(names(POSTGREST).slice(-2)).toEqual([POSTGREST.params.page, POSTGREST.params.cursor])
	})
})

describe("renderOrder", () => {
	it("spells a canonical order in each sort grammar", () => {
		expect(renderOrder(POSTGREST, "name.desc")).toBe("name.desc")
		expect(renderOrder(JSONAPI, "name.desc")).toBe("-name")
		expect(renderOrder(JSONAPI, "name.asc")).toBe("name")
		expect(renderOrder(PLAIN, "name.desc")).toBe("name:desc")
		expect(renderOrder(SPACED, "name.desc")).toBe("name desc")
		expect(renderOrder(TEMPLATE, "name.desc")).toBe("name_descending")
		expect(renderOrder(TEMPLATE, "name.asc")).toBe("name_ascending")
	})

	it("reads a bare field as ascending", () => {
		expect(renderOrder(POSTGREST, "name")).toBe("name.asc")
		expect(renderOrder(POSTGREST, "")).toBe(".asc")
	})
})
