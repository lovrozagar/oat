import { afterEach, describe, expect, it } from "vitest"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import { op } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext, notesModel, notesServer } from "../write/__fixtures__/notes.ts"
import { SYSTEM_CLOCK } from "./staleness-watch.ts"
import { STALENESS_TIMING, stalenessWithinBound } from "./staleness-within-bound.ts"

/*
 * After a write, a read sent past no bypass may answer the old value for a while. The check
 * measures how long; past a declared x-consistency.staleness it is a finding, and with none declared
 * the window is reported, never failed.
 */

afterEach(() => {
	STALENESS_TIMING.clock = SYSTEM_CLOCK
})

/** A notes backend whose reads that use the cache get a copy kept `windowMs` of the watch's clock. */
function cached(windowMs: number, more: { stalenessMs?: number; deleteOp?: false; override?: Responder } = {}) {
	let now = 0
	STALENESS_TIMING.clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
	}
	const server = notesServer()
	const copies = new Map<string, { answer: Answer; at: number }>()
	const respond: Responder = (method, path, options) => {
		const overridden = more.override?.(method, path, options)
		if (overridden !== undefined) return overridden
		if (method !== "GET" || options.cache !== "use") return server.respond(method, path, options)
		const copy = copies.get(path)
		if (copy !== undefined && now - copy.at < windowMs) {
			return {
				...copy.answer,
				headers: { age: String(Math.floor((now - copy.at) / 1000)), "cache-status": "edge; hit" },
			}
		}
		const answer = server.respond(method, path, options)
		if (answer?.status === 200) copies.set(path, { answer, at: now })
		return answer
	}
	const model = notesModel()
	const readOp = op(model, "note.get")
	return notesContext(model, respond, {
		readOp:
			more.stalenessMs === undefined
				? readOp
				: { ...readOp, consistency: { bypass: null, stalenessMs: more.stalenessMs } },
		records: [],
		...(more.deleteOp === false ? { deleteOp: undefined } : {}),
	})
}

/* The delete answers success and keeps the record. */
const keeps: Responder = (method) => (method === "DELETE" ? { body: {}, status: 200 } : undefined)

/* The update is refused; everything else answers. */
const refuse: Responder = (method) => (method === "PATCH" ? { status: 500 } : undefined)

const paths = (sent: { method: string; path: string; options: { cache?: string } }[]) =>
	sent.map((s) => `${s.method} ${s.path}${s.options.cache === "use" ? " (cache)" : ""}`)

describe("consistency.staleness-within-bound", () => {
	it("costs one read per write against an API that serves the write at once", async () => {
		const { ctx, findings, sent } = cached(0)
		expect(await runCheck(stalenessWithinBound, ctx)).toEqual({
			kind: "asserted",
			note:
				"after the update the read showed it at once; after the delete the read showed it at once; " +
				"no staleness is declared, so the window is reported, not judged",
		})
		expect(findings.findings).toEqual([])
		expect(paths(sent)).toEqual([
			"POST /notes",
			"GET /notes/n1 (cache)",
			"PATCH /notes/n1",
			"GET /notes/n1 (cache)",
			"POST /notes",
			"GET /notes/n2 (cache)",
			"DELETE /notes/n2",
			"GET /notes/n2 (cache)",
		])
	})

	it("passes a window inside the declared bound, and brackets it", async () => {
		const { ctx, findings } = cached(400, { stalenessMs: 1000 })
		expect(await runCheck(stalenessWithinBound, ctx)).toEqual({
			kind: "asserted",
			note:
				"after the update the read showed it at 550ms (still stale at 300ms); " +
				"after the delete the read showed it at 550ms (still stale at 300ms), within the declared 1000ms",
		})
		expect(findings.findings).toEqual([])
	})

	it("fails a read still stale at the declared bound, naming the bracket and what the cache said", async () => {
		const { ctx, findings } = cached(2500, { stalenessMs: 1000 })
		expect(await runCheck(stalenessWithinBound, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a cached read stayed stale past the staleness it declares")
		expect(findings.findings[0]?.detail).toBe(
			"after the update the read was still stale at 1050ms: GET /notes/n1 answered the old value past the " +
				"1000ms its x-consistency.staleness declares, no fresh read within it; the stale answer said " +
				"Cache-Status edge hit, Age 1",
		)
		expect(findings.findings[0]?.evidence.map((e) => e.method)).toEqual(["PATCH", "GET"])
	})

	it("only reports a window that never closes when no staleness is declared", async () => {
		const { ctx, findings, sent } = cached(60_000)
		expect(await runCheck(stalenessWithinBound, ctx)).toEqual({
			kind: "asserted",
			note:
				"after the update the read was still stale at 11250ms; after the delete the read was still stale at " +
				"11250ms; no staleness is declared, so the window is reported, not judged",
		})
		expect(findings.findings).toEqual([])
		expect(sent.filter((s) => s.options.cache === "use")).toHaveLength(2 * (1 + 8))
	})
})

describe("consistency.staleness-within-bound when it cannot write", () => {
	it("stands down when a read past the cache shows the write never took: that is no cache's doing", async () => {
		const { ctx, findings, sent } = cached(0, { override: keeps, stalenessMs: 1000 })
		expect(await runCheck(stalenessWithinBound, { ...ctx, updateOp: undefined })).toEqual({
			kind: "stood-down",
			reason: "a read past the cache does not show the delete either, so the write did not take",
		})
		expect(findings.findings).toEqual([])
		expect(sent.at(-1)?.options.cache).toBeUndefined()
	})

	it("stands down when the only write it can make is refused", async () => {
		const { ctx, findings } = cached(0, { deleteOp: false, override: refuse })
		expect(await runCheck(stalenessWithinBound, ctx)).toEqual({
			kind: "stood-down",
			reason: "the update answered 500",
		})
		expect(findings.findings).toEqual([])
	})

	it("measures the write it can make when the other is refused", async () => {
		const { ctx } = cached(0, { override: refuse })
		expect(await runCheck(stalenessWithinBound, ctx)).toMatchObject({
			kind: "asserted",
			note: "after the delete the read showed it at once; no staleness is declared, so the window is reported, not judged",
		})
	})

	it("cannot run without an update or a delete", () => {
		const { ctx } = cached(0, { deleteOp: false })
		expect(stalenessWithinBound.plan({ ...ctx, updateOp: undefined })).toEqual({
			needs: "an update or a delete whose effect the read can show",
			ok: false,
		})
	})
})
