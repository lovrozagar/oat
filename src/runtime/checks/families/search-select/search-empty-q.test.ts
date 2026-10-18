import { describe, expect, it } from "vitest"
import { PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { answering, notPaging } from "./__fixtures__/responders.ts"
import { searchEmptyQ } from "./search-empty-q.ts"

const policy = (searchEmpty: string) => ({ doc: queryDoc({ searchEmpty }) })
const pagedPolicy = (searchEmpty: string) => ({ doc: queryDoc({ searchEmpty }, [...PARAMS, "page"]) })

describe("search.empty-q under match-all and ignore", () => {
	it("passes an empty q that lists the unfiltered set", async () => {
		for (const declared of ["match-all", "ignore"]) {
			const staged = stage(searchEmptyQ, policy(declared))
			expect(await staged.run()).toEqual({ kind: "asserted" })
			expect(staged.sent.map((sent) => sent.options.query?.q)).toEqual([undefined, ""])
		}
	})

	it("fails an empty q that matches nothing", async () => {
		const respond = answering("q", "", { body: [], status: 200 })
		const staged = stage(searchEmptyQ, { ...policy("match-all"), respond })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("empty q did not match the unfiltered set")
		expect(finding?.detail).toBe("searchEmpty=match-all but q= returned 0 of 6 records.")
	})

	it("is unresolved when the empty q is refused", async () => {
		const staged = stage(searchEmptyQ, { ...policy("ignore"), respond: answering("q", "", REJECT) })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "empty q was rejected" })
	})

	it("is unresolved when neither set can be read whole", async () => {
		const staged = stage(searchEmptyQ, { ...pagedPolicy("match-all"), respond: notPaging })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sets are larger than a read covers" })
	})
})

describe("search.empty-q under reject", () => {
	it("passes a backend that refuses an empty q as invalid", async () => {
		const staged = stage(searchEmptyQ, { ...policy("reject"), respond: answering("q", "", REJECT) })
		expect(await staged.run()).toEqual({ kind: "asserted" })
	})

	it("fails a backend that serves an empty q it declared it refuses", async () => {
		const staged = stage(searchEmptyQ, policy("reject"))
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("empty q was not rejected")
		expect(staged.findings.findings[0]?.detail).toBe("searchEmpty=reject but q= returned 200.")
	})

	it("fails a crash and leaves an unrelated refusal unresolved", async () => {
		const crashed = stage(searchEmptyQ, { ...policy("reject"), respond: answering("q", "", { status: 500 }) })
		expect(await crashed.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const turnedAway = stage(searchEmptyQ, { ...policy("reject"), respond: answering("q", "", { status: 401 }) })
		expect(await turnedAway.run()).toMatchObject({ kind: "unresolved" })
	})
})

describe("search.empty-q plans", () => {
	it("stands down without a declared policy or a search parameter", async () => {
		const undeclared = stage(searchEmptyQ)
		expect(await undeclared.run()).toEqual({ kind: "stood-down", reason: "`searchEmpty` declared" })
		expect(undeclared.sent).toEqual([])
		const noParam = stage(searchEmptyQ, {
			doc: queryDoc(
				{ searchEmpty: "reject" },
				PARAMS.filter((name) => name !== "q"),
			),
		})
		expect(noParam.plan().ok).toBe(false)
	})
})
