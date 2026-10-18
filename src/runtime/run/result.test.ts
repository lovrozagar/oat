import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../client.ts"
import { contextOf, notesApi, optionsFor, planned } from "./__fixtures__/api.ts"
import { earlyResult, finalResult, scopeReport, settle } from "./result.ts"

/* The result as the report reads it: everything the run gathered, however far it got. */

const journaled = () => ({ exchangeDir: mkdtempSync(join(tmpdir(), "oat-result-")) })

describe("settle", () => {
	it("refreshes once more, releases the bodies, flushes the journal, and returns the credentials", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				...journaled(),
				principals: [
					{ headers: { authorization: "Bearer k" }, id: "a", inviteAs: "a@x.test", rank: 2, role: "admin" },
					{ id: "b" },
				],
			}),
		)
		const persisted = await settle(ctx)
		expect(persisted).toEqual([
			expect.objectContaining({ id: "a", inviteAs: "a@x.test", rank: 2, role: "admin" }),
			expect.objectContaining({ id: "b", rank: 0 }),
		])
		expect(persisted[1]).not.toHaveProperty("role")
		expect(persisted[1]).not.toHaveProperty("inviteAs")
	})
})

describe("earlyResult", () => {
	it("is a run that tested nothing, with the outage that cut it short and the journal so far", async () => {
		const run = await planned(optionsFor(notesApi(), journaled()))
		await run.network.note(Object.assign(new Error("x"), { attempts: 1, kind: "dns", url: "u" }) as never, "auth")
		const result = await earlyResult(run)
		expect(result).toMatchObject({ checksRun: [], created: 0, entitiesTested: [], principals: [], teardown: null })
		expect(result.network?.kind).toBe("dns")
		expect(result.exchanges).toEqual({ count: 0 })
	})
})

describe("a journal that cannot be flushed", () => {
	/* The journal is observability: a disk that fails it does not fail the run. */
	const failing = { count: 2, flush: () => Promise.reject(new Error("disk full")) } as never

	it("does not stop the run settling, or its early result", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		await expect(settle({ ...ctx, journal: failing })).resolves.toHaveLength(1)
		const run = await planned(optionsFor(notesApi()))
		await expect(earlyResult({ ...run, journal: failing })).resolves.toMatchObject({ exchanges: { count: 2 } })
	})
})

describe("finalResult", () => {
	it("carries the baseline, the version, the fence and an interruption when there were any", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				baseline: { entries: [], version: 1 } as never,
				fence: { failRun: false },
				hooks: { beforeRequest: () => ({ allow: true }) },
			}),
		)
		ctx.targetVersion = { value: "b-1" }
		ctx.state.interrupted = true
		ctx.state.checksRun.add("z.last").add("a.first")
		const result = finalResult(ctx, [], scopeReport(ctx))
		expect(result).toMatchObject({
			baseline: { fixed: [] },
			fenced: { failRun: false, requests: [] },
			interrupted: true,
			targetVersion: { value: "b-1" },
		})
		expect(result.checksRun).toEqual(["a.first", "z.last"])
	})

	it("leaves out what the run did not have, and names creates nothing could remove", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		expect(finalResult(ctx, [], scopeReport(ctx))).not.toHaveProperty("interrupted")
		expect(finalResult(ctx, [], scopeReport(ctx)).teardown).toBeNull()
		ctx.ledger.unidentified("note", "notes.create", { method: "POST", seq: 7, status: 201, url: "u" } as Exchange)
		expect(finalResult(ctx, [], scopeReport(ctx)).teardown).toMatchObject({
			removed: 0,
			unidentified: [expect.objectContaining({ seq: 7 })],
		})
		ctx.state.teardown = { failed: [], records: [], removed: 3, unidentified: [], unsupported: [] }
		expect(finalResult(ctx, [], scopeReport(ctx)).teardown).toMatchObject({
			removed: 3,
			unidentified: [expect.objectContaining({ seq: 7 })],
		})
	})
})
