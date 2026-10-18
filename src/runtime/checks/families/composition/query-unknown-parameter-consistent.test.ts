import { describe, expect, it } from "vitest"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import { endlessWhen, pagedDoc, rewriting, without } from "./__fixtures__/composition-b.ts"
import { backend, NOTES, PARAMS, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { unknownParameterConsistent } from "./query-unknown-parameter-consistent.ts"

const PLAIN = "oat_unknown_parameter"
const TYPO = "limit_oat_typo"

/* A backend that accepts, and ignores, both invented names. */
const lenient = backend(NOTES, { params: [...PARAMS, "page", PLAIN, TYPO] })

/* An invented name answered with `answer`; the plain listing is answered correctly. */
const answering = (answer: Answer): Responder =>
	rewriting((query) => (PLAIN in query || TYPO in query ? answer : query))

/* The defect UNKNOWN_PARAM_EMPTIES_LIST: an unknown name empties the listing, with a 200. */
const emptying = answering({ body: [], status: 200 })

/* The plain name refused, the typo ignored. */
const inconsistent = rewriting((query) => (PLAIN in query ? REJECT : without(query, TYPO)))

/* The typo refused with 422, the plain name ignored. */
const refusingTypo = rewriting((query) => (TYPO in query ? { status: 422 } : without(query, PLAIN)))

/* Both names refused, one with 400 and one with 422. */
const refusingBoth = rewriting((query) => (PLAIN in query ? REJECT : TYPO in query ? { status: 422 } : query))

describe("query.unknown-parameter-consistent passes", () => {
	it("a backend that refuses every unknown name, and says so", async () => {
		const staged = stage(unknownParameterConsistent)
		expect(await staged.run()).toEqual({
			kind: "asserted",
			note: "unknown query parameters are refused on the listing",
		})
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 50 },
			{ limit: 50, [PLAIN]: "1" },
			{ limit: 50, [TYPO]: "1" },
		])
	})

	it("a backend that refuses with 400 and 422 alike", async () => {
		expect(await stage(unknownParameterConsistent, { respond: refusingBoth }).run()).toMatchObject({
			note: "unknown query parameters are refused on the listing",
		})
	})

	it("a backend that ignores every unknown name", async () => {
		expect(await stage(unknownParameterConsistent, { respond: lenient }).run()).toEqual({
			kind: "asserted",
			note: "unknown query parameters are ignored on the listing",
		})
	})
})

describe("query.unknown-parameter-consistent fails", () => {
	it("an unknown name that empties the listing", async () => {
		const staged = stage(unknownParameterConsistent, { respond: emptying })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: expect.stringContaining(`adding ?${PLAIN}=1, a parameter the document does not declare, returned 0`),
			summary: "an unknown query parameter silently changes the result",
		})
		expect(staged.findings.findings[0]?.detail).toContain("where the plain listing returns 6, with no error.")
		expect(staged.findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("an unknown name that crashes the listing", async () => {
		const staged = stage(unknownParameterConsistent, { respond: answering({ status: 500 }) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: `adding ?${PLAIN}=1, a parameter the document does not declare, returned 500.`,
			summary: "an unknown query parameter crashes the listing",
		})
	})

	it("one unknown name refused and another ignored", async () => {
		for (const respond of [inconsistent, refusingTypo]) {
			const staged = stage(unknownParameterConsistent, { respond })
			expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(staged.findings.findings[0]?.summary).toBe("unknown query parameters are handled inconsistently")
			expect(staged.findings.findings[0]?.evidence).toHaveLength(2)
		}
		const staged = stage(unknownParameterConsistent, { respond: inconsistent })
		await staged.run()
		expect(staged.findings.findings[0]?.detail).toContain(`?${PLAIN}=1 was refused (400); ?${TYPO}=1 was ignored (200)`)
	})
})

describe("query.unknown-parameter-consistent gives up", () => {
	it("when the plain listing is refused or never finishes", async () => {
		expect(await stage(unknownParameterConsistent, { respond: () => REJECT }).run()).toEqual({
			kind: "unresolved",
			reason: "page 1 was answered with 400",
		})
		const endless = stage(unknownParameterConsistent, { doc: pagedDoc(), respond: endlessWhen() })
		expect(await endless.run()).toEqual({ kind: "unresolved", reason: "pages repeat the same records" })
	})

	it("when a probe is turned away for another reason", async () => {
		expect(await stage(unknownParameterConsistent, { respond: answering({ status: 403 }) }).run()).toEqual({
			kind: "unresolved",
			reason: `?${PLAIN}=1 was answered with 403, which says nothing about the parameter`,
		})
	})

	it("when a probe's walk never finishes", async () => {
		const respond = rewriting((query) => (PLAIN in query ? without(query, "page", PLAIN) : without(query, TYPO)))
		expect(await stage(unknownParameterConsistent, { doc: pagedDoc(), respond }).run()).toEqual({
			kind: "unresolved",
			reason: `?${PLAIN}=1 was answered with 200, which says nothing about the parameter`,
		})
	})
})

/* The plan for a listing that declares `params`. */
const typo = (params: string[]) => stage(unknownParameterConsistent, { doc: queryDoc({}, params) }).plan()

describe("query.unknown-parameter-consistent plans", () => {
	it("misspells the page size, else the page, else the order, else a plain `limit`", () => {
		expect(typo([...PARAMS])).toEqual({ ok: true, value: { names: [PLAIN, TYPO] } })
		expect(typo(["page", "order"])).toEqual({ ok: true, value: { names: [PLAIN, "page_oat_typo"] } })
		expect(typo(["order", "q"])).toEqual({ ok: true, value: { names: [PLAIN, "order_oat_typo"] } })
		expect(typo(["q"])).toEqual({ ok: true, value: { names: [PLAIN, TYPO] } })
	})

	it("calls the policy ignored when it is handed no names to probe", async () => {
		const staged = stage(unknownParameterConsistent)
		expect(await unknownParameterConsistent.run(staged.ctx, { names: [] })).toEqual({
			kind: "asserted",
			note: "unknown query parameters are ignored on the listing",
		})
		expect(staged.sent).toHaveLength(1)
	})

	it("stands down on an empty cohort", async () => {
		const staged = stage(unknownParameterConsistent, { rows: [] })
		expect(await staged.run()).toEqual({ kind: "stood-down", reason: "a listing and at least one record" })
		expect(staged.sent).toEqual([])
	})
})
