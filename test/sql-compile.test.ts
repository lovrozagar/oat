import { describe, expect, it } from "vitest"
import type { EntityDef } from "../src/reference/model.ts"
import { compileOrder, type SqlFlavour } from "../src/reference/stores/sql-compile.ts"

const entity = {
	fields: [
		{ name: "name", type: "string" },
		{ name: "seats", type: "integer" },
		{ name: "price", type: "number" },
		{ name: "active", type: "boolean" },
	],
} as unknown as EntityDef

/* Postgres's flavour as far as ordering reads it. */
const postgres = {
	binary: (expr: string) => `${expr} COLLATE "C"`,
	column: (_entity: EntityDef, field: string) => `"${field}"`,
	random: "random()",
	toText: (expr: string) => `${expr}::text`,
} as unknown as SqlFlavour

const term = (field: string) => ({ asText: false, descending: false, field, nullsFirst: false })

describe("compileOrder", () => {
	/* A collation on a bigint, double precision or boolean column is an error in Postgres, so
	 * only text columns may carry one — under either collation, including the one
	 * COLLATION_INCONSISTENT switches cursor resolution to. */
	for (const collation of ["binary", "insensitive"] as const) {
		it(`leaves non-text columns bare under ${collation} collation`, () => {
			for (const field of ["seats", "price", "active"]) {
				const sql = compileOrder([term(field)], collation, false, entity, postgres)
				expect(sql).toBe(` ORDER BY "${field}" IS NULL ASC, "${field}" ASC`)
			}
		})
	}

	it("applies the collation to text columns", () => {
		expect(compileOrder([term("name")], "binary", false, entity, postgres)).toContain(`"name" COLLATE "C" ASC`)
		expect(compileOrder([term("name")], "insensitive", false, entity, postgres)).toContain(`LOWER("name") ASC`)
	})
})
