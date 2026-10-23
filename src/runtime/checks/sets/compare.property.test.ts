import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Record_ } from "../../world/records.ts"
import { duplicates, membership, sameSet, setOf } from "./compare.ts"

/*
 * The set algebra the comparing checks rest on, against brute-force references over small sets:
 * set equality is an equivalence, a read's membership ignores order, duplicates are the repeats.
 */

const id = fc.constantFrom("a", "b", "c", "d", "e", "1", "2")
const smallSet = fc.uniqueArray(id, { maxLength: 5 }).map((items) => new Set(items))
/* Records with a scalar id, or none: a record without one is no member. */
const records: fc.Arbitrary<Record_[]> = fc.array(
	fc.oneof(
		id.map((value) => ({ id: value })),
		fc.integer({ max: 3, min: 0 }).map((value) => ({ id: value })),
		fc.constant({ name: "anonymous" }),
	),
	{ maxLength: 6 },
)

const sorted = (set: Set<string>) => [...set].toSorted().join("\n")

/* Another set, or `set` itself reordered, so equal sets turn up often. */
const nextTo = (set: Set<string>) =>
	fc.oneof(
		smallSet,
		fc.shuffledSubarray([...set], { minLength: set.size }).map((items) => new Set(items)),
	)
const triple = smallSet.chain((a) => nextTo(a).chain((b) => fc.tuple(fc.constant(a), fc.constant(b), nextTo(b))))
/* Another read, or `rows` again in another order. */
const twoReads = records.chain((rows) =>
	fc.tuple(fc.constant(rows), fc.oneof(records, fc.shuffledSubarray(rows, { minLength: rows.length }))),
)

describe("sameSet, by property", () => {
	it("agrees with comparing the sorted members", () => {
		fc.assert(
			fc.property(smallSet, smallSet, (a, b) => {
				expect(sameSet(a, b)).toBe(sorted(a) === sorted(b))
			}),
		)
	})

	it("is reflexive, symmetric and transitive", () => {
		fc.assert(
			fc.property(triple, ([a, b, c]) => {
				expect(sameSet(a, new Set(a))).toBe(true)
				expect(sameSet(a, b)).toBe(sameSet(b, a))
				expect(!(sameSet(a, b) && sameSet(b, c)) || sameSet(a, c)).toBe(true)
			}),
		)
	})
})

describe("membership and setOf, by property", () => {
	it("ignores the order a read returned its rows in", () => {
		const shuffled = records.chain((rows) =>
			fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length })),
		)
		fc.assert(
			fc.property(shuffled, ([rows, again]) => {
				expect(membership(again, "id")).toBe(membership(rows, "id"))
				expect(sameSet(setOf(again, "id"), setOf(rows, "id"))).toBe(true)
			}),
		)
	})

	it("counts each record with a scalar id, and only those", () => {
		fc.assert(
			fc.property(records, (rows) => {
				const members = rows.flatMap((row) => (row.id === undefined ? [] : [String(row.id)]))
				expect(setOf(rows, "id")).toEqual(new Set(members))
				expect(membership(rows, "id")).toBe(members.toSorted().join(","))
			}),
		)
	})

	it("reads two reads with one membership as holding one set", () => {
		fc.assert(
			fc.property(twoReads, ([a, b]) => {
				const oneMembership = membership(a, "id") === membership(b, "id")
				expect(!oneMembership || sameSet(setOf(a, "id"), setOf(b, "id"))).toBe(true)
			}),
		)
	})
})

describe("duplicates, by property", () => {
	it("returns each repeated value once, in the order it first repeats", () => {
		fc.assert(
			fc.property(fc.array(id, { maxLength: 8 }), (values) => {
				const repeats = values.filter((value, i) => values.indexOf(value) !== i)
				expect(duplicates(values)).toEqual([...new Set(repeats)])
			}),
		)
	})
})
