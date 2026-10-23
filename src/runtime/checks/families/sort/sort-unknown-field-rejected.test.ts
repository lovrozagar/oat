import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { NOTES, PARAMS, queryDoc, stage } from "../composition/__fixtures__/query-api.ts"
import { ignoring } from "./__fixtures__/sort-api.ts"
import { sortUnknownFieldRejected } from "./sort-unknown-field-rejected.ts"

/* Accepts the unknown field and serves the cohort reversed, unlike its default order. */
const reordering: Responder = (method, path, options) =>
	options.query?.["order"] === undefined
		? ignoring("order")(method, path, options)
		: { body: NOTES.toReversed(), status: 200 }

const answering =
	(status: number): Responder =>
	() => ({ body: {}, status })

describe("sort.unknown-field-rejected judges", () => {
	it("passes a backend that refuses ordering on an undeclared field", async () => {
		const staged = stage(sortUnknownFieldRejected)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 5, order: "oat_no_such_sort_xyz.asc" }])
	})

	it("fails a backend that drops the unknown field and serves its default order", async () => {
		const staged = stage(sortUnknownFieldRejected, { respond: ignoring("order") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "order on an undeclared field returned 200 with the default order, so the field was dropped.",
			summary: "unknown sort field is silently ignored",
		})
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 5, order: "oat_no_such_sort_xyz.asc" },
			{ limit: 5 },
		])
	})

	it("fails a backend that accepts the unknown field in some other order", async () => {
		const staged = stage(sortUnknownFieldRejected, { respond: reordering })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe("order on an undeclared field returned 200.")
	})

	it("fails a backend that crashes on the unknown field", async () => {
		const staged = stage(sortUnknownFieldRejected, { respond: answering(502) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("unknown sort field produces a server error")
	})

	it("is unresolved when the probe is turned away for another reason", async () => {
		const staged = stage(sortUnknownFieldRejected, { respond: answering(403) })
		expect(await staged.run()).toMatchObject({ kind: "unresolved" })
	})
})

describe("sort.unknown-field-rejected plans", () => {
	it("stands down without an order parameter", async () => {
		const doc = queryDoc(
			{},
			PARAMS.filter((name) => name !== "order"),
		)
		const staged = stage(sortUnknownFieldRejected, { doc })
		expect(await staged.run()).toEqual({ kind: "stood-down", reason: "an order parameter" })
		expect(staged.sent).toEqual([])
	})
})
