import { describe, expect, it } from "vitest"
import { DEFECTS, type DefectName } from "../../reference/defects/table.ts"
import { DIALECTS } from "../../reference/dialect/presets.ts"
import {
	WRITE_ONLY_FIELD_ONLY,
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

/** What a store or shape cannot show: where each rule applies, and which defects it leaves out. */
interface Exclusion {
	why: string
	applies: (backend: Backend, dialect: string) => boolean
	excludes: (name: DefectName) => boolean
}

const among =
	(set: ReadonlySet<DefectName>) =>
	(name: DefectName): boolean =>
		set.has(name)

const EXCLUSIONS: readonly Exclusion[] = [
	{ applies: () => true, excludes: among(CLIENT_ID_ONLY), why: "client-id shape only" },
	{ applies: (backend) => backend === "memory", excludes: among(SQL_ONLY), why: "SQL only" },
	{
		applies: (backend) => backend === "d1",
		excludes: (name) => !ENGINE_SENSITIVE.has(name),
		why: "D1 runs engine-sensitive only",
	},
	{
		applies: (backend) => backend !== "memory",
		excludes: (name) => name === "CONCURRENT_WRITE_LOST",
		why: "one engine",
	},
	{ applies: (_, dialect) => !DIALECTS_WITH_CURSOR.has(dialect), excludes: among(CURSOR_ONLY), why: "no cursor" },
	{ applies: (_, dialect) => !DIALECTS_WITH_TOTAL.has(dialect), excludes: among(COUNT_ONLY), why: "no total" },
	{
		applies: (_, dialect) => !DIALECTS_WITH_FILTER_EXPRESSION.has(dialect),
		excludes: among(EXPRESSION_ONLY),
		why: "no filter expression",
	},
	{
		applies: (_, dialect) => !DIALECTS_WITH_POSTGREST_FILTER.has(dialect),
		excludes: among(POSTGREST_OP_ONLY),
		why: "no postgrest operators",
	},
	{
		applies: (_, dialect) => DIALECTS[dialect]?.params.searchMode === undefined,
		excludes: among(SEARCH_MODE_ONLY),
		why: "no search mode",
	},
	{
		applies: (_, dialect) => DIALECTS[dialect]?.sortTemplate === undefined,
		excludes: among(DECLARED_SORT_ONLY),
		why: "no declared sort",
	},
	{
		applies: (_, dialect) => DIALECTS[dialect]?.params.page === undefined,
		excludes: (name) => name === "PAGE_PAST_END_REPEATS",
		why: "no page number",
	},
	{
		applies: (_, dialect) => (DIALECTS[dialect]?.sortGrammar ?? "dotted") !== "dotted",
		excludes: among(NULLS_TOKEN_ONLY),
		why: "no nulls token",
	},
	{
		applies: (_, dialect) => dialect !== "postgrest",
		excludes: (name) => name === "PATCH_REPLACES",
		why: "dialect-insensitive",
	},
]

describe("defectsFor", () => {
	it("runs every defect but the client-id and write-only-field shapes' on SQLite under PostgREST", () => {
		expect(defectsFor("sqlite", "postgrest").length).toBeGreaterThan(ALL.length - 13)
		expect(none(defectsFor("sqlite", "postgrest"), SQL_ONLY)).toEqual([...SQL_ONLY])
	})

	it("narrows to the filter, and an empty filter is no filter", () => {
		expect(defectsFor("memory", "postgrest", ["STALE_LIST", "NOT_A_DEFECT"])).toEqual(["STALE_LIST"])
		expect(defectsFor("memory", "postgrest", [])).toEqual(defectsFor("memory", "postgrest"))
	})

	it("leaves out what a store or shape structurally cannot show", () => {
		const leaks = BACKENDS.flatMap((backend) =>
			[...Object.keys(DIALECTS), "unknown"].flatMap((dialect) => {
				const names = defectsFor(backend, dialect)
				return EXCLUSIONS.filter((rule) => rule.applies(backend, dialect)).flatMap((rule) =>
					names.filter(rule.excludes).map((name) => `${backend}/${dialect} ${rule.why}: ${name}`),
				)
			}),
		)
		expect(leaks).toEqual([])
	})

	it("runs a store- and dialect-blind defect once: in memory, under PostgREST", () => {
		const where = BACKENDS.flatMap((backend) =>
			Object.keys(DIALECTS)
				.filter((dialect) => defectsFor(backend, dialect).includes("DISCRIMINATOR_BRANCH_WRONG"))
				.map((dialect) => `${backend}/${dialect}`),
		)
		expect(where).toEqual(["memory/postgrest"])
	})

	it("keeps each shape-bound defect where its shape has the feature", () => {
		const everywhere = new Set(
			BACKENDS.flatMap((backend) => Object.keys(DIALECTS).flatMap((dialect) => defectsFor(backend, dialect))),
		)
		expect(ALL.filter((name) => !everywhere.has(name)).toSorted()).toEqual(
			[...CLIENT_ID_ONLY, ...WRITE_ONLY_FIELD_ONLY].toSorted(),
		)
	})
})
