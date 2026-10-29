import { describe, expect, it } from "vitest"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import { op } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext, notesModel, notesServer } from "../write/__fixtures__/notes.ts"
import { bypassIsFresh } from "./bypass-is-fresh.ts"

/*
 * A read that declares a cache bypass must answer past every cache when sent it: right after a
 * write, one read with the bypass shows the write and no cache says it answered.
 */

const BYPASS = { name: "x-fresh", value: "1" }

/** A notes backend that keeps every read's first 200 and serves it again, unless `honors` and the bypass is sent. */
function cached(
	more: {
		honors?: boolean
		label?: (fresh: boolean) => Record<string, string>
		declared?: boolean
		plain?: boolean
	} = {},
) {
	const server = notesServer()
	const copies = new Map<string, Answer>()
	const respond: Responder = (method, path, options) => {
		if (method !== "GET") return server.respond(method, path, options)
		const headers = typeof options.headers === "function" ? options.headers() : (options.headers ?? {})
		const bypassed = (more.honors ?? true) && headers[BYPASS.name] === BYPASS.value
		const copy = copies.get(path)
		if (!bypassed && copy !== undefined)
			return more.plain === true ? copy : { ...copy, headers: { "cache-status": "edge; hit" } }
		const answer = server.respond(method, path, options)
		if (answer?.status === 200 && !bypassed) copies.set(path, answer)
		return answer === undefined ? undefined : { ...answer, headers: more.label?.(bypassed) ?? {} }
	}
	const model = notesModel()
	const readOp = op(model, "note.get")
	const consistency = more.declared === false ? null : { bypass: BYPASS, stalenessMs: 1000 }
	return notesContext(model, respond, { readOp: { ...readOp, consistency }, records: [] })
}

describe("consistency.bypass-is-fresh on a delete", () => {
	it("fails a deleted record a cache still serves past the bypass, with no Cache-Status to quote", async () => {
		const { ctx, findings } = cached({ honors: false, plain: true })
		expect(await runCheck(bypassIsFresh, { ...ctx, updateOp: undefined })).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(findings.findings[0]?.detail).toBe(
			"right after the delete, GET /notes/n1 sent x-fresh: 1 answered the old record",
		)
	})

	it("cannot run without an update or a delete", () => {
		const { ctx } = cached()
		expect(bypassIsFresh.plan({ ...ctx, deleteOp: undefined, updateOp: undefined })).toEqual({
			needs: "a create, and an update or a delete",
			ok: false,
		})
	})
})

const paths = (sent: { method: string; path: string; options: { cache?: string; headers?: unknown } }[]) =>
	sent.map((s) => `${s.method} ${s.path}${s.options.cache === "use" ? " (cache)" : ""}`)

describe("consistency.bypass-is-fresh", () => {
	it("cannot run on a read that declares no bypass, or when the config sends none", () => {
		expect(bypassIsFresh.plan(cached({ declared: false }).ctx)).toEqual({
			needs: "a read that declares an x-consistency bypass",
			ok: false,
		})
		expect(bypassIsFresh.plan({ ...cached().ctx, cacheBypass: false })).toEqual({
			needs: "the cache bypass, which config cache.bypass turns off",
			ok: false,
		})
	})

	it("passes when one read with the bypass shows the write right after it", async () => {
		const { ctx, findings, sent } = cached()
		expect(await runCheck(bypassIsFresh, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(paths(sent)).toEqual(["POST /notes", "GET /notes/n1 (cache)", "PATCH /notes/n1", "GET /notes/n1"])
		expect(sent[3]?.options.headers).toEqual({ "x-fresh": "1" })
	})

	it("fails a read that answers its cached copy though sent the bypass", async () => {
		const { ctx, findings } = cached({ honors: false })
		expect(await runCheck(bypassIsFresh, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a read sent its declared cache bypass did not skip the cache")
		expect(findings.findings[0]?.detail).toBe(
			"right after the update, GET /notes/n1 sent x-fresh: 1 answered the old value; Cache-Status edge hit",
		)
		expect(findings.findings[0]?.evidence.map((e) => e.method)).toEqual(["PATCH", "GET"])
	})

	it("fails a fresh answer whose Cache-Status says a cache answered it", async () => {
		const { ctx, findings } = cached({ label: () => ({ "cache-status": "edge; hit" }) })
		expect(await runCheck(bypassIsFresh, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toBe(
			"right after the update, GET /notes/n1 sent x-fresh: 1 answered a cache hit; Cache-Status edge hit",
		)
	})

	it("passes a fresh answer whose cache says it forwarded the request", async () => {
		const { ctx } = cached({ label: (fresh) => ({ "cache-status": fresh ? "edge; fwd=bypass" : "edge; hit" }) })
		expect(await runCheck(bypassIsFresh, ctx)).toEqual({ kind: "asserted" })
	})
})
