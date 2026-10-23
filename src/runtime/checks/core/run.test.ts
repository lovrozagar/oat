import { describe, expect, it } from "vitest"
import type { Outcome } from "../../finding.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import type { Check } from "./check.ts"
import { cannot, ready } from "./plan.ts"
import { checkSalts, NEEDS_LIST, planOn, runCheck, runOn } from "./run.ts"

/*
 * What the scheduler does for one check: plan it, and run it only when the plan applies, with what
 * the plan found; otherwise the check stands down, saying what it needed.
 */

/** A check whose plan is `plan` and whose run records the value it was handed. */
function stubCheck(plan: Check["plan"], needs?: string): { check: Check; ran: unknown[] } {
	const ran: unknown[] = []
	const check: Check = {
		id: "sort.order-is-applied",
		plan,
		run: async (_ctx, value) => {
			ran.push(value)
			return { kind: "asserted" } satisfies Outcome
		},
		subjects: () => [],
		...(needs === undefined ? {} : { needs }),
	}
	return { check, ran }
}

describe("runCheck", () => {
	it("runs the check with what its plan found", async () => {
		const { check, ran } = stubCheck(() => ready({ field: "name" }))
		expect(await runCheck(check, notesContext().ctx)).toEqual({ kind: "asserted" })
		expect(ran).toEqual([{ field: "name" }])
	})

	it("stands down with what the plan says is missing, and never runs", async () => {
		const { check, ran } = stubCheck(() => cannot("a sortable field"), "the check's own needs")
		expect(await runCheck(check, notesContext().ctx)).toEqual({ kind: "stood-down", reason: "a sortable field" })
		expect(ran).toEqual([])
	})

	it("falls back to the check's own needs, then to an unstated precondition", async () => {
		const stated = stubCheck(() => cannot(), "a list endpoint")
		expect(await runCheck(stated.check, notesContext().ctx)).toEqual({ kind: "stood-down", reason: "a list endpoint" })
		const unstated = stubCheck(() => cannot())
		expect(await runCheck(unstated.check, notesContext().ctx)).toEqual({
			kind: "stood-down",
			reason: "an unstated precondition",
		})
	})
})

/** A check that reads the listing, recording what its plan handed its run. */
function listing(): { check: Check; ran: unknown[] } {
	const ran: unknown[] = []
	const check: Check = {
		id: "sort.order-is-applied",
		lists: true,
		plan: (ctx) => ready(ctx.listOp.operationId),
		run: async (_ctx, value) => {
			ran.push(value)
			return { kind: "asserted" } satisfies Outcome
		},
		subjects: () => [],
	}
	return { check, ran }
}

/** The notes context with no list. */
const unlistedContext = () => ({ ...notesContext().ctx, listOp: undefined })

describe("a check that reads the entity's listing", () => {
	it("plans and runs on an entity with a list", async () => {
		const { check, ran } = listing()
		expect(await runCheck(check, notesContext().ctx)).toEqual({ kind: "asserted" })
		expect(ran).toEqual(["note.list"])
	})

	it("is skipped as needing a list on an entity with none, and never runs", async () => {
		const { check, ran } = listing()
		expect(planOn(check, unlistedContext())).toEqual({ needs: NEEDS_LIST, ok: false })
		expect(await runCheck(check, unlistedContext())).toEqual({ kind: "stood-down", reason: NEEDS_LIST })
		expect(await runOn(check, unlistedContext(), "note.list")).toEqual({ kind: "stood-down", reason: NEEDS_LIST })
		expect(ran).toEqual([])
	})

	it("leaves a check that needs no list to plan and run on an entity with none", async () => {
		const { check, ran } = stubCheck(() => ready("item"))
		expect(await runCheck(check, unlistedContext())).toEqual({ kind: "asserted" })
		expect(ran).toEqual(["item"])
	})
})

describe("checkSalts", () => {
	it("draws a fixed sequence for one check on one entity", () => {
		const draw = checkSalts(3, 1)
		const drawn = Array.from({ length: 11 }, draw)
		expect(drawn.slice(0, 2)).toEqual(["3.1.0", "3.1.1"])
		expect(drawn[10]).toBe("3.1.a")
		const again = checkSalts(3, 1)
		expect(again()).toBe("3.1.0")
	})

	it("never shares a salt between two checks or two entities", () => {
		const a = Array.from({ length: 5 }, checkSalts(1, 2))
		const b = Array.from({ length: 5 }, checkSalts(2, 1))
		const c = Array.from({ length: 5 }, checkSalts(12, 1))
		expect(new Set([...a, ...b, ...c]).size).toBe(15)
	})
})
