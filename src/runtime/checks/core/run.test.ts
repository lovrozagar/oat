import { describe, expect, it } from "vitest"
import { emptyCapabilities } from "../../../spec/query/merge.ts"
import { queryOver, type Withheld } from "../../../spec/query/sendable.ts"
import type { Outcome } from "../../finding.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import type { Check } from "./check.ts"
import type { CheckContext } from "./context.ts"
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

/* The list can sort by `name` and filter by `id`, but declares no parameter for either. */
function withheld() {
	const { ctx } = notesContext()
	const capabilities = { ...emptyCapabilities(), filterable: [], sortable: [] }
	return {
		...ctx,
		capabilities,
		query: queryOver(ctx.query, capabilities),
		withheld: [
			{ axis: "filterable", row: { field: "id" } },
			{ axis: "sortable", row: { field: "name" } },
		] satisfies Withheld[],
	}
}

describe("runCheck with withheld query capabilities", () => {
	it("stands down naming the parameter whose absence is all that stopped the plan", async () => {
		const sorts = stubCheck((ctx: CheckContext) =>
			ctx.query?.sortable[0] === undefined ? cannot("a sortable field") : ready({}),
		)
		expect(await runCheck(sorts.check, withheld())).toEqual({
			kind: "stood-down",
			reason: "a sort parameter, which the list operation does not declare",
		})
		expect(sorts.ran).toEqual([])
		const filters = stubCheck((ctx: CheckContext) =>
			ctx.query?.filterable.includes("id") === true ? ready({}) : cannot(),
		)
		expect(await runCheck(filters.check, withheld())).toMatchObject({
			reason: "the `id` query parameter, which the list operation does not declare",
		})
	})

	it("names every withheld parameter when the plan needs more than one of them", async () => {
		const both = stubCheck((ctx: CheckContext) =>
			(ctx.query?.sortable.length ?? 0) > 0 && (ctx.query?.filterable.length ?? 0) > 0 ? ready({}) : cannot(),
		)
		expect(await runCheck(both.check, withheld())).toMatchObject({
			reason:
				"the `id` query parameter, which the list operation does not declare; a sort parameter, which the list " +
				"operation does not declare",
		})
	})

	it("still needs a list for a check that reads one, on an entity with none, whatever was withheld", async () => {
		const sorts: Check = {
			id: "sort.order-is-applied",
			lists: true,
			plan: (ctx) => (ctx.query?.sortable[0] === undefined ? cannot("a sortable field") : ready({})),
			run: async () => ({ kind: "asserted" }),
			subjects: () => [],
		}
		expect(await runCheck(sorts, { ...withheld(), listOp: undefined })).toEqual({
			kind: "stood-down",
			reason: NEEDS_LIST,
		})
	})

	it("keeps the plan's own needs when the withheld parameters would not have let it run", async () => {
		const { check } = stubCheck(() => cannot("a declared defaultOrder"))
		expect(await runCheck(check, withheld())).toMatchObject({ reason: "a declared defaultOrder" })
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
