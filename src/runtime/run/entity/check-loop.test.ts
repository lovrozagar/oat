import { describe, expect, it } from "vitest"
import type { Outcome } from "../../finding.ts"
import { contextOf, notesApi, optionsFor } from "../__fixtures__/api.ts"
import { checkOf, loopOf } from "../__fixtures__/checks.ts"
import type { RunOptions } from "../types.ts"
import { runChecks } from "./check-loop.ts"
import type { Check } from "./run-check.ts"

/*
 * Every check on an entity, in order: readers batched together, a writer alone, a check whose
 * premise already failed suppressed — transitively, naming the root cause — and a check that does
 * not apply recorded, never dropped.
 */

async function looped(checks: readonly Check[], extra: Partial<RunOptions> = {}) {
	const ctx = await contextOf(optionsFor(notesApi(), extra))
	const loop = await loopOf(ctx)
	await runChecks(loop.run, loop.context, checks)
	return ctx
}

const failing = (id: string) =>
	checkOf({
		id,
		run: async (view) => view.findings.backend(id, "note", "broken", "d", []),
	})

/** A check that records when it starts and ends, so a test can see what ran alongside it. */
function traced(id: string, log: string[], extra: { mutates?: boolean; dependsOn?: string[] } = {}): Check {
	return checkOf({
		...extra,
		id,
		run: async (): Promise<Outcome> => {
			log.push(`${id}+`)
			await new Promise((resolve) => setTimeout(resolve, 1))
			log.push(`${id}-`)
			return { kind: "asserted" }
		},
	})
}

describe("runChecks scheduling", () => {
	it("runs readers together, and a writer alone once they have finished", async () => {
		const log: string[] = []
		await looped([traced("r1", log), traced("r2", log), traced("w", log, { mutates: true }), traced("r3", log)])
		expect(log).toEqual(["r1+", "r2+", "r1-", "r2-", "w+", "w-", "r3+", "r3-"])
	})

	it("lets a check that judges the transcript run once everything before it has sent", async () => {
		const log: string[] = []
		const judge = checkOf({ id: "j", judgesTranscript: true, run: async () => (log.push("j"), { kind: "asserted" }) })
		await looped([traced("r1", log), judge])
		expect(log).toEqual(["r1+", "r1-", "j"])
	})

	it("flushes the batch before a check that depends on one already in it", async () => {
		const log: string[] = []
		await looped([traced("a", log), traced("b", log, { dependsOn: ["a"] })])
		expect(log).toEqual(["a+", "a-", "b+", "b-"])
	})

	it("starts no check once the run is stopped", async () => {
		const controller = new AbortController()
		controller.abort()
		const ctx = await looped([traced("never", [])], { signal: controller.signal })
		expect(ctx.state.checksRun.has("never")).toBe(false)
	})
})

describe("runChecks suppression", () => {
	it("suppresses a check whose premise failed, and one depending on that, naming the root cause", async () => {
		const ctx = await looped([
			failing("root"),
			checkOf({ dependsOn: ["root"], id: "mid", mutates: true }),
			checkOf({ dependsOn: ["mid"], id: "leaf" }),
			checkOf({ dependsOn: ["clean"], id: "fine" }),
		])
		expect(ctx.state.checksSuppressed).toEqual([
			{ because: "root", check: "mid", entity: "note" },
			{ because: "root", check: "leaf", entity: "note" },
		])
		expect(ctx.state.checksRun.has("fine")).toBe(true)
		expect([...(ctx.grades.suppressed.get("notes.list") ?? [])]).toEqual(["mid", "leaf"])
	})

	it("suppresses a check whose premise was reported broken before any check ran", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const loop = await loopOf(ctx)
		ctx.findings.backend("create.does-not-error", "note", "crashed", "d", [])
		ctx.findings.backend("create.does-not-error", "tag", "crashed", "d", [])
		await runChecks(loop.run, loop.context, [checkOf({ dependsOn: ["create.does-not-error"], id: "after" })])
		expect(ctx.state.checksSuppressed).toEqual([{ because: "create.does-not-error", check: "after", entity: "note" }])
	})

	it("does not suppress for a premise that stood down", async () => {
		const ctx = await looped([
			checkOf({ id: "shy", run: async () => ({ kind: "stood-down", reason: "nothing" }) }),
			checkOf({ dependsOn: ["shy"], id: "after" }),
		])
		expect(ctx.state.checksSuppressed).toEqual([])
		expect(ctx.state.checksRun.has("after")).toBe(true)
	})
})

describe("runChecks planning", () => {
	it("records a check whose plan does not apply, by what it needed", async () => {
		const ctx = await looped([
			checkOf({ id: "said", plan: { needs: "an update route", ok: false } }),
			checkOf({ id: "own", needs: "a search field", plan: { ok: false } }),
			checkOf({ id: "silent", plan: { ok: false } }),
		])
		expect(ctx.state.checksSkipped.map((skip) => skip.needs)).toEqual([
			"an update route",
			"a search field",
			"an unstated precondition",
		])
		expect([...(ctx.grades.needs.get("notes.list") ?? [])]).toEqual([
			"an update route",
			"a search field",
			"an unstated precondition",
		])
	})

	it("leaves a check out of a targeted run that grades none of its targets", async () => {
		const ctx = await looped([checkOf({ id: "other", subjects: ["notes.get"] }), checkOf({ id: "kept" })], {
			ops: ["notes.list"],
		})
		expect(ctx.state.checksOutOfScope).toEqual([{ check: "other", entity: "note" }])
		expect(ctx.state.checksRun.has("kept")).toBe(true)
	})

	it("grades nothing the profile excludes", async () => {
		const ctx = await looped([checkOf({ id: "both", subjects: ["notes.list", "notes.update"] })], {
			profile: "p",
			profiles: { p: { exclude: ["notes.update"] } },
		})
		expect(ctx.grades.ran.has("notes.update")).toBe(false)
		expect(ctx.grades.ran.has("notes.list")).toBe(true)
	})
})
