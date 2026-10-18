import { afterEach, describe, expect, it, vi } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { backend, NOTES, PARAMS, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { answering, caseSensitive, notPaging } from "./__fixtures__/responders.ts"
import { searchCaseInsensitive } from "./search-case-insensitive.ts"

/* Lets one test have the repeat reads come back refused, which a set read never reports itself. */
const settle = vi.hoisted(() => ({ refused: false }))
vi.mock("../../sets/compare.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../sets/compare.ts")>()
	return {
		...real,
		settlePair: (...args: Parameters<typeof real.settlePair>) =>
			settle.refused ? Promise.resolve(null) : real.settlePair(...args),
	}
})
afterEach(() => {
	settle.refused = false
})

const INSENSITIVE = { doc: queryDoc({ searchCase: "insensitive" }) }

/* Case-sensitive, and a record lands between the first and the repeat read of "Alpha". */
function movingSensitive(): Responder {
	let reads = 0
	return (method, path, options) => {
		if (queryOf(options).q === "Alpha") reads += 1
		if (reads < 2) return caseSensitive(method, path, options)
		return backend([...NOTES, { id: "n7", title: "Alpha late" }])(method, path, options)
	}
}

describe("search.case-insensitive judges", () => {
	it("passes a search that selects the same set whatever the case, flipping one letter", async () => {
		const staged = stage(searchCaseInsensitive)
		expect(staged.plan()).toEqual({ ok: true, value: { flipped: "alpha", token: "Alpha" } })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.q)).toEqual(["Alpha", "alpha"])
	})

	it("fails a case-sensitive search when the document declares it insensitive", async () => {
		const staged = stage(searchCaseInsensitive, { ...INSENSITIVE, respond: caseSensitive })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("search is not case-insensitive")
		expect(finding?.detail).toBe('q="Alpha" and q="alpha" selected different sets.')
	})

	it("leaves a case-sensitive search unresolved when the document does not say", async () => {
		const staged = stage(searchCaseInsensitive, { respond: caseSensitive })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "case-flipped search selected a different set; declare searchCase: insensitive to treat that as a defect",
		})
		expect(staged.findings.findings).toEqual([])
	})
})

describe("search.case-insensitive gives up", () => {
	it("is unresolved when either search is refused", async () => {
		for (const term of ["Alpha", "alpha"]) {
			const staged = stage(searchCaseInsensitive, { respond: answering("q", term, REJECT) })
			expect(await staged.run()).toEqual({ kind: "unresolved", reason: "a case-flipped search was rejected" })
		}
	})

	it("is unresolved when the sets cannot be read whole", async () => {
		const staged = stage(searchCaseInsensitive, { doc: queryDoc({}, [...PARAMS, "page"]), respond: notPaging })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sets are larger than a read covers" })
	})

	it("reads a disagreement that does not repeat as the collection moving", async () => {
		const staged = stage(searchCaseInsensitive, { ...INSENSITIVE, respond: movingSensitive() })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("gained or lost") })
		expect(staged.findings.findings).toEqual([])
	})

	it("is unresolved when the repeat reads are refused", async () => {
		settle.refused = true
		const staged = stage(searchCaseInsensitive, { respond: caseSensitive })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "a case-flipped search was rejected" })
	})

	it.todo("reports a refused repeat read as rejected, not as the collection moving")
})

describe("search.case-insensitive plans", () => {
	it("takes the first word with a letter, skipping values that are not text or hold none", () => {
		const rows = [
			{ id: "a", title: 42 },
			{ id: "b", title: "123 456" },
			{ id: "c", title: "7 bravo Charlie" },
		]
		expect(stage(searchCaseInsensitive, { rows }).plan()).toEqual({
			ok: true,
			value: { flipped: "Bravo", token: "bravo" },
		})
	})

	it("stands down without a search parameter or a searchable word", async () => {
		const noParam = stage(searchCaseInsensitive, {
			doc: queryDoc(
				{},
				PARAMS.filter((name) => name !== "q"),
			),
		})
		expect(await noParam.run()).toEqual({ kind: "stood-down", reason: "a searchable string with a letter" })
		expect(stage(searchCaseInsensitive, { rows: [{ id: "a", title: "123" }] }).plan().ok).toBe(false)
		expect(stage(searchCaseInsensitive, { fields: { query: null } }).plan().ok).toBe(false)
	})
})
