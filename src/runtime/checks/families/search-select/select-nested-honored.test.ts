import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world/records.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { NOTES, PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { ignoring, projecting } from "./__fixtures__/responders.ts"
import { selectNestedHonored } from "./select-nested-honored.ts"

const RELATION = { fields: ["name"], name: "author" }
const NESTED = { doc: queryDoc({ select: { nested: true, relations: [RELATION] } }) }

/* Every listed record's author replaced by `author`. */
const authoredBy =
	(author: unknown): Responder =>
	() => ({ body: NOTES.map((row) => ({ author, id: row["id"] })), status: 200 })

/* The projection, with each author turned into a to-many list of itself. */
const toMany: Responder = projecting((row: Record_) => ({
	...row,
	author: row["author"] === null ? [] : [row["author"]],
}))

/* Whether the check plans against a document declaring `select` and `params`. */
const declared = (select: unknown, params: readonly string[] = PARAMS): boolean =>
	stage(selectNestedHonored, { doc: queryDoc({ select }, params) }).plan().ok

/* An empty listing, whatever is asked. */
const empty: Responder = () => ({ body: [], status: 200 })

describe("select.nested-honored judges", () => {
	it("passes a relation cut to the requested field, skipping records without one", async () => {
		const staged = stage(selectNestedHonored, NESTED)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 5, select: "id,author(name)" }])
	})

	it("passes a to-many relation of records cut to the requested field", async () => {
		expect(await stage(selectNestedHonored, { ...NESTED, respond: toMany }).run()).toEqual({ kind: "asserted" })
	})

	it("fails a nested select whose relation keeps every field", async () => {
		const staged = stage(selectNestedHonored, { ...NESTED, respond: ignoring("select") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("nested select did not restrict the relation to the requested field")
		expect(finding?.detail).toBe("select=author(name) returned email, name.")
	})

	it("fails a relation returned as a scalar, or a to-many list holding one", async () => {
		const scalar = stage(selectNestedHonored, { ...NESTED, respond: authoredBy("Ann") })
		expect(await scalar.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(scalar.findings.findings[0]?.detail).toBe('select=author(name) left "author" holding "Ann".')
		const listed = stage(selectNestedHonored, { ...NESTED, respond: authoredBy([{ name: "Ann" }, null]) })
		expect(await listed.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(listed.findings.findings[0]?.summary).toBe("nested select did not return the relation as records")
		const nested = stage(selectNestedHonored, { ...NESTED, respond: authoredBy([["Ann"]]) })
		expect(await nested.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})
})

describe("select.nested-honored gives up", () => {
	it("is unresolved when the nested select is refused or empty", async () => {
		const reason = "nested select was rejected or empty"
		expect(await stage(selectNestedHonored, { ...NESTED, respond: () => REJECT }).run()).toEqual({
			kind: "unresolved",
			reason,
		})
		expect(await stage(selectNestedHonored, { ...NESTED, respond: empty }).run()).toEqual({
			kind: "unresolved",
			reason,
		})
	})

	it("is unresolved when no listed record has the relation", async () => {
		expect(await stage(selectNestedHonored, { ...NESTED, respond: authoredBy(null) }).run()).toEqual({
			kind: "unresolved",
			reason: 'no listed record has a "author" to project',
		})
	})
})

describe("select.nested-honored plans", () => {
	it("stands down without nested select, a named relation with a field, or a select parameter", async () => {
		const flat = stage(selectNestedHonored)
		expect(await flat.run()).toEqual({ kind: "stood-down", reason: "select.nested and a named relation" })
		expect(flat.sent).toEqual([])
		expect(declared({ nested: true })).toBe(false)
		expect(declared({ nested: true, relations: [{ fields: [], name: "author" }] })).toBe(false)
		expect(
			declared(
				{ nested: true, relations: [RELATION] },
				PARAMS.filter((name) => name !== "select"),
			),
		).toBe(false)
	})
})
