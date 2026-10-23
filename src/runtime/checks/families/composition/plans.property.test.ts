import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world/records.ts"
import { PARAMS, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { overlapPlan, subsetPlan } from "./plans.ts"
import { queryAxesCompose } from "./query-axes-compose.ts"

/*
 * Subset and overlap planning over random small cohorts, against brute-force references written
 * from the plans' own definitions: a proper subset holds more than one record and fewer than all;
 * an overlap has a filtered group and a search token each matching something the other does not.
 */

const FILTERABLE = ["status", "rank", "title"] as const
const SEARCHABLE = ["title"]

const cohort: fc.Arbitrary<Record_[]> = fc
	.array(
		fc.record({
			rank: fc.option(fc.integer({ max: 3, min: 1 }), { nil: undefined }),
			status: fc.option(fc.constantFrom("open", "closed", "draft"), { nil: null }),
			title: fc.option(
				fc
					.array(fc.constantFrom("ab", "Ab", "cd", "abc", "xy", "q"), { maxLength: 3, minLength: 1 })
					.map((words) => words.join(" ")),
				{ nil: null },
			),
		}),
		{ maxLength: 7 },
	)
	.map((rows) => rows.map((row, i) => ({ id: `r${i}`, ...row })))

const contextOf = (rows: Record_[]) =>
	stage(queryAxesCompose, {
		doc: queryDoc({ filterable: [...FILTERABLE], searchable: SEARCHABLE }, PARAMS),
		rows,
	}).ctx

const key = (value: unknown) => JSON.stringify(value)
const present = (value: unknown) => value !== null && value !== undefined

/* The ids of the records holding `value` on `field`. */
const holding = (rows: Record_[], field: string, value: unknown) =>
	new Set(rows.filter((row) => present(row[field]) && key(row[field]) === key(value)).map((row) => String(row.id)))

const isProper = (group: Set<string>, rows: Record_[]) => group.size > 1 && group.size < rows.length

/* Every proper-subset group, by field in declared order, then by first holder. */
function properGroups(rows: Record_[]): Array<{ field: string; group: Set<string> }> {
	return FILTERABLE.flatMap((field) => {
		const seen = new Map<string, Set<string>>()
		for (const row of rows) if (present(row[field])) seen.set(key(row[field]), holding(rows, field, row[field]))
		return [...seen.values()].filter((group) => isProper(group, rows)).map((group) => ({ field, group }))
	})
}

/* The ids a case-insensitive substring search for `token` over the titles finds. */
const searched = (rows: Record_[], token: string) =>
	new Set(
		rows
			.filter((row) =>
				String(row.title ?? "")
					.toLowerCase()
					.includes(token.toLowerCase()),
			)
			.map((row) => String(row.id)),
	)

/* The tokens the plan may try: a title, its first three letters, its words of two letters or more. */
const tokens = (rows: Record_[]) =>
	rows.flatMap((row) => {
		const title = row.title
		if (typeof title !== "string" || title.length < 2) return []
		return [
			title,
			...(title.length >= 3 ? [title.slice(0, 3)] : []),
			...title.split(/\s+/).filter((w) => w.length >= 2),
		]
	})

const overlaps = (a: Set<string>, b: Set<string>) =>
	[...a].some((id) => b.has(id)) && [...a].some((id) => !b.has(id)) && [...b].some((id) => !a.has(id))

describe("subsetPlan, by property", () => {
	it("is ready exactly when a proper-subset value exists, and picks the first field holding one", () => {
		fc.assert(
			fc.property(cohort, (rows) => {
				const plan = subsetPlan(contextOf(rows))
				const groups = properGroups(rows)
				expect(plan.ok).toBe(groups.length > 0)
				if (!plan.ok) return
				const { field, target, term } = plan.value
				expect(field).toBe(groups[0]?.field)
				expect(isProper(holding(rows, field, target[field]), rows)).toBe(true)
				expect(term).toEqual({ filter: `${field}.eq.${String(target[field])}` })
			}),
			{ numRuns: 60 },
		)
	})
})

describe("overlapPlan, by property", () => {
	it("is ready exactly when some proper group and title token overlap without nesting", () => {
		fc.assert(
			fc.property(cohort, (rows) => {
				const plan = overlapPlan(contextOf(rows))
				const exists = properGroups(rows).some(({ group }) =>
					tokens(rows).some((token) => overlaps(group, searched(rows, token))),
				)
				expect(plan.ok).toBe(exists)
				if (!plan.ok) return
				const { field, target, token } = plan.value
				const group = holding(rows, field, target[field])
				expect(isProper(group, rows)).toBe(true)
				expect(overlaps(group, searched(rows, token))).toBe(true)
				/* The relation is symmetric: neither side nests in the other. */
				expect(overlaps(searched(rows, token), group)).toBe(true)
			}),
			{ numRuns: 60 },
		)
	})
})
