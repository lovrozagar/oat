import { describe, expect, it } from "vitest"
import { MissingValueError } from "../../../errors/missing-value.ts"
import { AuthRefreshError } from "../../client.ts"
import { FencedError } from "../../fence.ts"
import { checkOf, loopOf } from "../__fixtures__/checks.ts"
import { contextOf, notesApi, optionsFor, outage } from "../__fixtures__/api.ts"
import type { Client } from "../../client.ts"
import type { CheckSpec } from "../__fixtures__/checks.ts"
import { runCheck, withLostVariants } from "./run-check.ts"

/*
 * One check on one entity: it runs with a view of its own, its outcome is what it reported, an
 * error is mapped to what it means, and its subjects are graded by how it ended.
 */

const GRADED = ["notes.list", "notes.get"]

async function ran(spec: CheckSpec, graded = GRADED) {
	const ctx = await contextOf(optionsFor(notesApi()))
	const loop = await loopOf(ctx)
	await runCheck(loop, { check: checkOf(spec), graded })
	return { ctx, loop, outcome: loop.outcomes.get(spec.id) }
}

const throwing = (error: unknown) => async () => {
	throw error
}

describe("runCheck outcomes", () => {
	it("grades every subject of a check that asserted, timing it and keeping its note", async () => {
		const { ctx, outcome } = await ran({ id: "c.pass", run: async () => ({ kind: "asserted", note: "policy seen" }) })
		expect(outcome).toEqual({ kind: "asserted", note: "policy seen" })
		expect([...(ctx.grades.ran.get("notes.get") ?? [])]).toEqual(["c.pass"])
		expect(ctx.state.checkNotes).toEqual([{ check: "c.pass", entity: "note", note: "policy seen" }])
		expect(ctx.state.checkTimings).toEqual([{ check: "c.pass", entity: "note", ms: expect.any(Number) }])
		expect(ctx.state.checksRun.has("c.pass")).toBe(true)
		expect(ctx.progress).toMatchObject({ check: "c.pass", phase: "test" })
	})

	it("grades only the subjects a check said it judged", async () => {
		const { ctx } = await ran({
			id: "c.narrow",
			run: async (view) => {
				view.judged?.(["notes.get"])
				return { kind: "asserted" }
			},
		})
		expect(ctx.grades.ran.has("notes.list")).toBe(false)
		expect(ctx.grades.ran.has("notes.get")).toBe(true)
	})

	it("takes what a check reported for its outcome, though it fell through to asserted", async () => {
		const { ctx, outcome } = await ran({
			id: "c.reported",
			run: async (view) => {
				view.findings.backend("c.reported", "note", "s", "d", [])
				return { kind: "asserted" }
			},
		})
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(ctx.findings.findings[0]?.operations).toEqual(GRADED)
	})

	it("records a check that stood down as skipped, naming the variants the seed lost", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const loop = await loopOf(ctx)
		loop.run.lostVariants = ["max"]
		await runCheck(loop, {
			check: checkOf({ id: "c.down", run: async () => ({ kind: "stood-down", reason: "a cohort record" }) }),
			graded: [],
		})
		const needs = 'a cohort record (the cohort is missing its "max" variant, which failed to seed)'
		expect(ctx.state.checksSkipped).toEqual([{ check: "c.down", entity: "note", needs }])
	})

	it("gives a check that does not mutate a client that refuses to write", async () => {
		const { ctx, outcome } = await ran({
			id: "c.reader",
			run: async (view) => {
				await (view.client as unknown as Client).request("POST", "/notes", { body: { title: "x" } })
				return { kind: "asserted" }
			},
		})
		expect(outcome?.kind).toBe("stood-down")
		expect(ctx.findings.findings[0]?.detail).toMatch(/does not mutate/)
	})
})

describe("runCheck clients", () => {
	it("gives a mutating check a client that writes", async () => {
		const { outcome } = await ran({
			id: "c.writer",
			mutates: true,
			run: async (view) => {
				const made = await (view.client as unknown as Client).request("POST", "/notes", { body: { title: "x" } })
				return made.status === 201 ? { kind: "asserted" } : { kind: "unresolved", reason: String(made.status) }
			},
		})
		expect(outcome).toEqual({ kind: "asserted" })
	})
})

describe("runCheck errors", () => {
	it("leaves a check unresolved when the network failed, noting the outage", async () => {
		const { ctx, outcome } = await ran({ id: "c.net", run: throwing(outage("dns")) })
		expect(outcome).toEqual({ kind: "unresolved", reason: "the network failed" })
		expect(ctx.network.outcome?.kind).toBe("dns")
		expect(ctx.state.checkTimings).toEqual([])
	})

	it("blocks a check whose request was fenced", async () => {
		const fenced = new FencedError({ method: "POST", phase: "assertion", reason: "no writes", url: "u" })
		const { ctx, outcome } = await ran({ id: "c.fenced", run: throwing(fenced) })
		expect(outcome).toEqual({ kind: "unresolved", reason: "a request was fenced" })
		expect(ctx.findings.findings[0]).toMatchObject({ check: "fence", summary: "c.fenced was fenced: no writes" })
	})

	it("leaves a check unresolved for a value nobody supplied", async () => {
		const { outcome } = await ran({ id: "c.missing", run: throwing(new MissingValueError("no captcha")) })
		expect(outcome).toEqual({ kind: "unresolved", reason: "oat had no value for no captcha" })
	})

	it("blocks a check whose credential could not be refreshed, naming the principal when known", async () => {
		const named = await ran({ id: "c.auth", run: throwing(new AuthRefreshError("alpha", new Error("expired"))) })
		expect(named.ctx.findings.findings[0]?.summary).toBe('refreshing the credential of "alpha" failed')
		const unnamed = await ran({ id: "c.auth", run: throwing(new AuthRefreshError(undefined, "gone")) })
		expect(unnamed.ctx.findings.findings[0]?.summary).toBe("refreshing the credential failed")
		expect(unnamed.outcome).toEqual({ kind: "unresolved", reason: "a credential could not be refreshed" })
	})

	it("reports any other error as the check's own gap", async () => {
		const { ctx, outcome } = await ran({ id: "c.bug", run: throwing(new Error("oops")) }, [])
		/* A gap is no verdict on the API: the check stood down, and the report says why. */
		expect(outcome?.kind).toBe("stood-down")
		expect(ctx.findings.findings[0]).toMatchObject({ detail: "oops", summary: 'check "c.bug" could not complete' })
	})
})

describe("withLostVariants", () => {
	it("names lost variants only for a need about the cohort", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const { run } = await loopOf(ctx)
		expect(withLostVariants(run, "a cohort record")).toBe("a cohort record")
		run.lostVariants = ["min", "max"]
		expect(withLostVariants(run, "an update route")).toBe("an update route")
		expect(withLostVariants(run, "a record")).toBe(
			'a record (the cohort is missing its "min", "max" variants, which failed to seed)',
		)
	})
})
