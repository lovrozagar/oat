import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { backend, NOTES, PARAMS, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { answering, notPaging } from "./__fixtures__/responders.ts"
import { searchTokensAnd } from "./search-tokens-and.ts"

/* Searches by the first token alone and drops the rest. */
const firstTokenOnly: Responder = (method, path, options) => {
	const query = queryOf(options)
	const first = query.q?.split(" ")[0]
	return backend()(method, path, { query: first === undefined ? query : { ...query, q: first } })
}

/* Reads several tokens as OR: any one of them selects a record. */
const tokensAsOr: Responder = (method, path, options) => {
	const query = queryOf(options)
	if (query.q !== "Alpha Beta") return backend()(method, path, options)
	return { body: NOTES.filter((row) => /alpha|beta/i.test(String(row.title))), status: 200 }
}

describe("search.tokens-and judges", () => {
	it("passes tokens applied as AND, reading each token and then both", async () => {
		const staged = stage(searchTokensAnd)
		expect(staged.plan()).toEqual({ ok: true, value: { a: "Alpha", b: "Beta" } })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.q)).toEqual(["Alpha", "Beta", "Alpha Beta"])
	})

	it("passes tokens applied as OR: the union is an accepted reading", async () => {
		expect(await stage(searchTokensAnd, { respond: tokensAsOr }).run()).toEqual({ kind: "asserted" })
	})

	it("fails a search that applies only the first token", async () => {
		const staged = stage(searchTokensAnd, { respond: firstTokenOnly })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("two search tokens are not applied as AND")
		expect(finding?.detail).toBe('q="Alpha Beta" returned 2; the intersection of each token is 0.')
		expect(finding?.evidence).toHaveLength(3)
	})
})

describe("search.tokens-and gives up", () => {
	it("is unresolved when any token search is refused", async () => {
		for (const token of ["Alpha", "Beta", "Alpha Beta"]) {
			const staged = stage(searchTokensAnd, { respond: answering("q", token, REJECT) })
			expect(await staged.run()).toEqual({ kind: "unresolved", reason: "a token search was rejected" })
		}
	})

	it("is unresolved when the sets cannot be read whole", async () => {
		const staged = stage(searchTokensAnd, { doc: queryDoc({}, [...PARAMS, "page"]), respond: notPaging })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sets are larger than a read covers" })
	})

	it("is unresolved when a token taken from the cohort matches nothing", async () => {
		const noA = stage(searchTokensAnd, { respond: answering("q", "Alpha", { body: [], status: 200 }) })
		expect(await noA.run()).toMatchObject({ reason: expect.stringContaining('(q="Alpha")') })
		const noB = stage(searchTokensAnd, { respond: answering("q", "Beta", { body: [], status: 200 }) })
		expect(await noB.run()).toMatchObject({ reason: expect.stringContaining('(q="Beta")') })
	})
})

describe("search.tokens-and plans", () => {
	it("skips values that are not text or hold no word of three letters", () => {
		const rows = [
			{ id: "a", title: null },
			{ id: "b", title: "ab cd" },
			{ id: "c", title: "one" },
			{ id: "d", title: "two" },
		]
		expect(stage(searchTokensAnd, { rows }).plan()).toEqual({ ok: true, value: { a: "one", b: "two" } })
	})

	it("stands down without two distinct tokens", () => {
		const rows = NOTES.map((row) => ({ ...row, title: "same words" }))
		expect(stage(searchTokensAnd, { rows }).plan()).toEqual({
			needs: "two discriminating search tokens in the cohort",
			ok: false,
		})
		const one = [...NOTES.slice(0, 3).map((row) => ({ ...row, title: "x" })), { id: "n9", title: "only" }]
		expect(stage(searchTokensAnd, { rows: one }).plan().ok).toBe(false)
	})

	it("stands down without a search parameter, a searchable field, or more than two records", async () => {
		const noParam = stage(searchTokensAnd, {
			doc: queryDoc(
				{},
				PARAMS.filter((name) => name !== "q"),
			),
		})
		expect(await noParam.run()).toEqual({
			kind: "stood-down",
			reason: "searchable fields and two tokens that split the cohort",
		})
		expect(stage(searchTokensAnd, { doc: queryDoc({ searchable: [] }) }).plan().ok).toBe(false)
		expect(stage(searchTokensAnd, { fields: { query: null } }).plan().ok).toBe(false)
		expect(stage(searchTokensAnd, { rows: NOTES.slice(0, 2) }).plan().ok).toBe(false)
	})
})
