import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { backend, NOTES, PARAMS, queryDoc, queryOf, stage } from "../composition/__fixtures__/query-api.ts"
import { sortInvalidDirectionRejected } from "./sort-invalid-direction-rejected.ts"

/* A dotted grammar declared, so the direction tokens are the document's own. */
const declared = queryDoc({ sortGrammar: "dotted" })

/* Reads a direction it does not know as ascending. */
const guessing: Responder = (method, path, options) => {
	const query = queryOf(options)
	return backend()(method, path, { query: { ...query, order: query.order?.replace("oatsideways", "asc") } })
}

/* Accepts a direction it does not know, and serves the cohort in its own order. */
const shrugging: Responder = (method, path, options) => {
	const query = queryOf(options)
	return query.order?.endsWith("oatsideways") === true
		? { body: NOTES.toReversed(), status: 200 }
		: backend()(method, path, options)
}

const answering =
	(status: number): Responder =>
	() => ({ body: {}, status })

describe("sort.invalid-direction-rejected judges", () => {
	it("passes a backend that refuses a direction its grammar lacks", async () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: declared })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["title.oatsideways"])
	})

	it("fails a backend that reads an unknown direction as ascending", async () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: declared, respond: guessing })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("an unknown sort direction is accepted")
		expect(staged.findings.findings[0]?.detail).toBe(
			"order=title.oatsideways returned 200 in ascending order, so the direction was read as ascending. " +
				"A direction the declared grammar does not have must be refused, not guessed.",
		)
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["title.oatsideways", "title.asc"])
	})

	it("fails a backend that accepts an unknown direction in some other order", async () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: declared, respond: shrugging })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe(
			"order=title.oatsideways returned 200. A direction the declared grammar does not have must be refused, not guessed.",
		)
	})

	it("fails a backend that crashes on an unknown direction", async () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: declared, respond: answering(500) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("an unknown sort direction produces a server error")
	})

	it("is unresolved when the probe is turned away for another reason", async () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: declared, respond: answering(401) })
		expect(await staged.run()).toMatchObject({ kind: "unresolved" })
		expect(staged.findings.findings).toEqual([])
	})
})

describe("sort.invalid-direction-rejected plans", () => {
	it("probes the identity when it is the one sortable field", () => {
		const staged = stage(sortInvalidDirectionRejected, { doc: queryDoc({ sortGrammar: "dotted", sortable: ["id"] }) })
		expect(staged.plan()).toEqual({ ok: true, value: { control: "id.asc", order: "id.oatsideways" } })
	})

	it("stands down without an order parameter or a declared grammar", async () => {
		const unordered = queryDoc(
			{ sortGrammar: "dotted" },
			PARAMS.filter((name) => name !== "order"),
		)
		expect(stage(sortInvalidDirectionRejected, { doc: unordered }).plan().ok).toBe(false)
		const inferred = stage(sortInvalidDirectionRejected)
		expect(await inferred.run()).toEqual({
			kind: "stood-down",
			reason: "a declared sort grammar with a token for each direction",
		})
		expect(inferred.sent).toEqual([])
	})

	it("needs a sortable field, and a grammar with a token for ascending", () => {
		const unsortable = stage(sortInvalidDirectionRejected, { doc: queryDoc({ sortGrammar: "dotted", sortable: [] }) })
		expect(unsortable.plan()).toEqual({ needs: "a sortable field", ok: false })
		const prefixed = stage(sortInvalidDirectionRejected, { doc: queryDoc({ sortGrammar: "prefixed" }) })
		expect(prefixed.plan()).toEqual({ needs: "a sort grammar with a token for each direction", ok: false })
	})
})
