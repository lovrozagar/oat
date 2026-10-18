import { describe, expect, it } from "vitest"
import { DEFECTS, type DefectName } from "../../reference/defects.ts"
import { DIALECTS } from "../../reference/dialect.ts"
import {
	CLIENT_ID_ONLY,
	COUNT_ONLY,
	CURSOR_ONLY,
	DECLARED_SORT_ONLY,
	defectsFor,
	DIALECTS_WITH_CURSOR,
	DIALECTS_WITH_FILTER_EXPRESSION,
	DIALECTS_WITH_POSTGREST_FILTER,
	DIALECTS_WITH_TOTAL,
	ENGINE_SENSITIVE,
	EXPRESSION_ONLY,
	NULLS_TOKEN_ONLY,
	POSTGREST_OP_ONLY,
	SEARCH_MODE_ONLY,
	SQL_ONLY,
} from "./defects.ts"
import type { Backend } from "./engines.ts"

const BACKENDS: readonly Backend[] = ["memory", "sqlite", "postgres", "d1"]
const ALL = Object.keys(DEFECTS) as DefectName[]
const none = (names: DefectName[], set: ReadonlySet<DefectName>): DefectName[] => names.filter((n) => set.has(n))

describe("defectsFor", () => {
	it("runs every defect but the client-id shape's on SQLite under PostgREST", () => {
		expect(defectsFor("sqlite", "postgrest").length).toBeGreaterThan(ALL.length - 12)
		expect(none(defectsFor("sqlite", "postgrest"), SQL_ONLY)).toEqual([...SQL_ONLY])
	})

	it("narrows to the filter, and an empty filter is no filter", () => {
		expect(defectsFor("memory", "postgrest", ["STALE_LIST", "NOT_A_DEFECT"])).toEqual(["STALE_LIST"])
		expect(defectsFor("memory", "postgrest", [])).toEqual(defectsFor("memory", "postgrest"))
	})

	it("leaves out what a store or shape structurally cannot show", () => {
		for (const backend of BACKENDS) {
			for (const dialect of [...Object.keys(DIALECTS), "unknown"]) {
				const names = defectsFor(backend, dialect)
				const shape = DIALECTS[dialect]
				expect(none(names, CLIENT_ID_ONLY)).toEqual([])
				if (backend === "memory") expect(none(names, SQL_ONLY)).toEqual([])
				if (backend === "d1") expect(names.filter((n) => !ENGINE_SENSITIVE.has(n))).toEqual([])
				if (backend !== "memory") expect(names).not.toContain("CONCURRENT_WRITE_LOST")
				if (!DIALECTS_WITH_CURSOR.has(dialect)) expect(none(names, CURSOR_ONLY)).toEqual([])
				if (!DIALECTS_WITH_TOTAL.has(dialect)) expect(none(names, COUNT_ONLY)).toEqual([])
				if (!DIALECTS_WITH_FILTER_EXPRESSION.has(dialect)) expect(none(names, EXPRESSION_ONLY)).toEqual([])
				if (!DIALECTS_WITH_POSTGREST_FILTER.has(dialect)) expect(none(names, POSTGREST_OP_ONLY)).toEqual([])
				if (shape?.params.searchMode === undefined) expect(none(names, SEARCH_MODE_ONLY)).toEqual([])
				if (shape?.sortTemplate === undefined) expect(none(names, DECLARED_SORT_ONLY)).toEqual([])
				if (shape?.params.page === undefined) expect(names).not.toContain("PAGE_PAST_END_REPEATS")
				if ((shape?.sortGrammar ?? "dotted") !== "dotted") expect(none(names, NULLS_TOKEN_ONLY)).toEqual([])
				if (dialect !== "postgrest") expect(names).not.toContain("PATCH_REPLACES")
			}
		}
	})

	it("keeps each shape-bound defect where its shape has the feature", () => {
		const everywhere = new Set(
			BACKENDS.flatMap((backend) => Object.keys(DIALECTS).flatMap((dialect) => defectsFor(backend, dialect))),
		)
		expect(ALL.filter((name) => !everywhere.has(name)).toSorted()).toEqual([...CLIENT_ID_ONLY].toSorted())
	})
})
