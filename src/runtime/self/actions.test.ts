import { describe, expect, it } from "vitest"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { me, selfInput } from "./__fixtures__/me.ts"
import { runSelfActions } from "./actions.ts"
import type { CreatedCaller } from "./create.ts"

const created = (body: Record<string, unknown>): CreatedCaller => ({
	body,
	exchange: exchange("POST", "/me", { status: 201 }),
})

function act(answer: Answer, query: string[], caller: CreatedCaller | null) {
	const { input, findings, sent } = selfInput(() => answer, me({ action: query }))
	return { findings, result: runSelfActions(input, findings, caller), sent }
}

describe("runSelfActions", () => {
	it("asks each action about what the create sent, and passes when it answers about that", async () => {
		const { result, sent } = act(
			{ body: { handle: "h", other: 1 }, status: 200 },
			["handle", "n", "b"],
			created({ b: false, handle: "h", n: 2 }),
		)
		expect(await result).toBeNull()
		expect(sent[0]?.options.query).toEqual({ b: "false", handle: "h", n: "2" })
		expect(sent[0]?.options.as).toEqual({ principal: "alpha" })
	})

	it("passes on an answer that names none of the query, or is not a record", async () => {
		expect(
			await act({ body: { unrelated: true }, status: 200 }, ["handle"], created({ handle: "h" })).result,
		).toBeNull()
		expect(await act({ body: "ok", status: 200 }, ["handle"], created({ handle: "h" })).result).toBeNull()
	})

	it("cannot ask without the values the create would have sent", async () => {
		const { result, sent } = act({ status: 200 }, ["handle", "tag"], created({ handle: "h", tag: { x: 1 } }))
		expect(await result).toEqual({ kind: "unresolved", reason: "me.lookup needs tag and the create did not send it" })
		expect(sent).toEqual([])
		expect(await act({ status: 200 }, ["handle"], null).result).toMatchObject({ kind: "unresolved" })
	})

	it("reports an action that failed, or answered about another value", async () => {
		const failed = act({ status: 500 }, ["handle"], created({ handle: "h" }))
		expect(await failed.result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(failed.findings.findings[0]?.detail).toBe('me.lookup returned 500 for {"handle":"h"}.')
		const other = act({ body: { handle: "x" }, status: 200 }, ["handle"], created({ handle: "h" }))
		expect(await other.result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(other.findings.findings[0]?.detail).toBe('me.lookup was asked for handle=h and returned "x".')
	})

	it("has nothing to do without actions", async () => {
		const { input, findings } = selfInput(() => undefined)
		expect(await runSelfActions(input, findings, null)).toBeNull()
	})
})
