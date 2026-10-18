import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress/types.ts"
import { createdId } from "../proven-id.ts"
import type { Record_ } from "../world/records.ts"
import { contextOf, flow, notesApi, notesDoc, optionsFor, withLogin } from "./__fixtures__/api.ts"
import type { RunContext } from "./context.ts"
import { reportUnremovable, teardownPrincipals, trackCreates, unwind } from "./teardown.ts"
import type { RunOptions } from "./types.ts"

/*
 * What the run made, it removes: every create a principal sent is ledgered as it, the ledger
 * unwinds after the checks and again after the scenarios, and accounts the run provisioned go
 * last — or are named as left behind.
 */

const id = (value: string) => createdId(value) as NonNullable<ReturnType<typeof createdId>>

async function contextWith(rows: Record_[], extra: Partial<RunOptions> = {}): Promise<RunContext> {
	return contextOf(optionsFor(notesApi(notesDoc(), rows), extra))
}

/** Ledgers `count` notes the API holds, as the first principal. */
function seed(ctx: RunContext, rows: Record_[], count: number): void {
	const owner = ctx.principals.ownerOf(ctx.principals.alpha)
	for (let index = 1; index <= count; index++) {
		rows.push({ id: `n${index}`, title: `t${index}` })
		ctx.principals.recorder(owner)("note", id(`n${index}`), {})
	}
}

async function verifyRemoved(): Promise<never> {
	throw new Error("hook down")
}

describe("trackCreates", () => {
	it("ledgers a create a principal sent, and marks its identity taken", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows)
		const taken = new Set<string>()
		ctx.state.takenByEntity.set("note", taken)
		trackCreates(ctx)
		await ctx.client.request("POST", "/notes", { body: { title: "x" }, headers: ctx.principals.alpha.headers })
		expect(ctx.ledger.size).toBe(1)
		expect(taken).toEqual(new Set([String(rows[0]?.id)]))
	})

	it("ledgers a create of an entity no seeding has started", async () => {
		const ctx = await contextWith([])
		trackCreates(ctx)
		await ctx.client.request("POST", "/notes", { body: { title: "x" }, headers: ctx.principals.alpha.headers })
		expect(ctx.ledger.size).toBe(1)
	})
})

describe("unwind", () => {
	it("removes what was ledgered, showing its progress every 25 records and at the end", async () => {
		const rows: Record_[] = []
		const snaps: ProgressSnapshot[] = []
		const ctx = await contextWith(rows, { onProgress: (snap) => snaps.push(snap) })
		seed(ctx, rows, 26)
		ctx.progress.check = "c1"
		await unwind(ctx)
		expect(rows).toEqual([])
		expect(ctx.state.teardown).toMatchObject({ failed: [], removed: 26, unsupported: [] })
		const said = snaps.flatMap((snap) => snap.message ?? [])
		/* Newest first: the unwind reverses creation order, so children go before their parents. */
		expect(said.slice(said.indexOf("26 record(s)"))).toEqual(["26 record(s)", "25/26 note n2", "26/26 note n1"])
		expect(snaps.at(-1)).toMatchObject({ phase: "teardown" })
		expect(snaps.at(-1)).not.toHaveProperty("check")
	})

	it("adds a second unwind's report to the first", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows, { teardown: { verify: false } })
		seed(ctx, rows, 1)
		await unwind(ctx)
		rows.push({ id: "m1", title: "m" })
		ctx.principals.recorder(ctx.principals.ownerOf(ctx.principals.alpha))("note", id("m1"), {})
		await unwind(ctx)
		expect(ctx.state.teardown?.removed).toBe(2)
		expect(ctx.state.teardown?.records).toHaveLength(2)
	})
})

describe("unwind edge cases", () => {
	it("leaves everything in place when asked to keep fixtures, or when nothing was made", async () => {
		const rows: Record_[] = []
		const kept = await contextWith(rows, { keepFixtures: true })
		seed(kept, rows, 1)
		await unwind(kept)
		expect(rows).toHaveLength(1)
		const empty = await contextWith([])
		await unwind(empty)
		expect(empty.state.teardown).toBeNull()
	})

	it("reports a verify hook that threw once, however many unwinds it threw in", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows, { hooks: { verifyRemoved } as never })
		seed(ctx, rows, 1)
		await unwind(ctx)
		seed(ctx, rows, 1)
		await unwind(ctx)
		expect(ctx.findings.findings.filter((finding) => finding.check === "teardown.verify-hook")).toEqual([
			expect.objectContaining({ summary: "hooks.verifyRemoved threw" }),
		])
		expect(ctx.state.verifyHookFailed).toBe(true)
	})

	it("reports a teardown that stopped on an unexpected error", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows)
		seed(ctx, rows, 1)
		const broken: RunContext = {
			...ctx,
			principals: { ...ctx.principals, fallbackDeleters: () => [] },
			model: null as never,
		}
		await unwind(broken)
		expect(ctx.findings.findings).toEqual([
			/* Counted after the unwind took the records off the ledger, as it always was. */
			expect.objectContaining({
				check: "world.teardown",
				summary: "teardown stopped on an unexpected error with 0 record(s) ledgered",
			}),
		])
	})
})

describe("reportUnremovable", () => {
	it("names the entities whose records no delete reaches", async () => {
		const ctx = await contextWith([])
		reportUnremovable(ctx)
		expect(ctx.findings.findings).toEqual([])
		ctx.state.teardown = { failed: [], records: [], removed: 0, unidentified: [], unsupported: ["note", "tag"] }
		reportUnremovable(ctx)
		expect(ctx.findings.findings).toEqual([expect.objectContaining({ check: "world.teardown", entity: "note, tag" })])
	})
})

describe("teardownPrincipals", () => {
	it("removes each account the run provisioned through the hook", async () => {
		const removed: string[] = []
		const ctx = await contextOf(
			optionsFor(withLogin(), {
				hooks: { teardownPrincipal: async (address, auth) => void removed.push(`${address} ${auth.credential}`) },
				principals: [{ headers: { authorization: "Bearer k" }, id: "static" }, flow],
			}),
		)
		await teardownPrincipals(ctx)
		expect(removed).toEqual(["a@x.test token-1"])
	})

	it("names the accounts left behind without a hook, and one the hook could not remove", async () => {
		const bare = await contextOf(optionsFor(withLogin(), { principals: [flow] }))
		await teardownPrincipals(bare)
		expect(bare.findings.findings[0]).toMatchObject({
			summary: "1 principal(s) provisioned by this run were not removed",
		})
		const failing = await contextOf(
			optionsFor(withLogin(), {
				hooks: {
					teardownPrincipal: async () => {
						throw new Error("cannot delete")
					},
				},
				principals: [flow],
			}),
		)
		await teardownPrincipals(failing)
		expect(failing.findings.findings[0]).toMatchObject({
			detail: "cannot delete",
			summary: "could not remove provisioned principal a@x.test",
		})
	})

	it("leaves the accounts to the primary run, and has nothing to do without provisioned accounts", async () => {
		const secondary = await contextOf(optionsFor(withLogin(), { principals: [flow], skipPrincipalTeardown: true }))
		await teardownPrincipals(secondary)
		const plain = await contextWith([])
		await teardownPrincipals(plain)
		expect([...secondary.findings.findings, ...plain.findings.findings]).toEqual([])
	})
})
