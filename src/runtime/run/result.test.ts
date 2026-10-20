import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import { contextOf, LOGIN, notesApi, optionsFor, planned, withLogin } from "./__fixtures__/api.ts"
import { earlyResult, finalResult, scopeReport, settle } from "./result.ts"

/* The result as the report reads it: everything the run gathered, however far it got. */

const journaled = () => ({ exchangeDir: mkdtempSync(join(tmpdir(), "oat-result-")) })

const AS_A = { as: { principal: "a" } }

describe("settle", () => {
	it("releases the bodies, flushes the journal, and returns the principals with no credential value", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				...journaled(),
				principals: { a: { email: "a@x.test", inviteAs: "a@x.test", rank: 2, tenant: "t1" }, b: {} },
			}),
		)
		await ctx.client.get("/notes", AS_A)
		const settled = await settle(ctx)
		expect(settled).toEqual({
			principals: [
				{
					credentials: [{ expiresAt: null, scheme: "bearer", scopes: [] }],
					id: "a",
					identity: { email: "a@x.test" },
					inviteAs: "a@x.test",
					rank: 2,
					scope: {},
					tenant: "t1",
				},
				{ credentials: [], id: "b", identity: {}, rank: 0, scope: {} },
			],
		})
		expect(JSON.stringify(settled)).not.toContain("alpha-key")
	})

	it("keeps a principal that could not sign in, with the reason it was BLOCKED", async () => {
		const ctx = await contextOf(
			optionsFor(withLogin({ failing: true, issued: 0 }), {
				principals: { alpha: { rank: 1, security: { bearer: { static: "a" } } }, beta: { scope: { org_id: "o2" } } },
				security: LOGIN,
			}),
		)
		const persisted = (await settle(ctx)).principals
		expect(persisted.map((principal) => [principal.id, principal.blocked])).toEqual([
			["alpha", undefined],
			["beta", expect.stringMatching(/^login for beta\/bearer: .*got 500/)],
		])
		expect(persisted[1]).toMatchObject({ credentials: [], rank: 0, scope: { org_id: "o2" } })
	})

	it("returns the values the principals held when the run was asked to keep them", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { keepCredentials: true }))
		await ctx.client.get("/notes", { as: { principal: "alpha" } })
		expect((await settle(ctx)).credentials).toEqual([
			{ expiresAt: null, principal: "alpha", scheme: "bearer", scopes: [], value: "alpha-key" },
		])
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
		await expect(settle({ ...ctx, journal: failing })).resolves.toMatchObject({ principals: [{ id: "alpha" }] })
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
		const result = finalResult(ctx, { principals: [] }, scopeReport(ctx))
		expect(result).toMatchObject({
			baseline: { fixed: [] },
			fenced: { failRun: false, requests: [] },
			interrupted: true,
			targetVersion: { value: "b-1" },
		})
		expect(result.checksRun).toEqual(["a.first", "z.last"])
		expect(result).not.toHaveProperty("credentials")
		const kept = [{ expiresAt: null, principal: "alpha", scheme: "bearer", scopes: [], value: "v" }]
		expect(finalResult(ctx, { credentials: kept, principals: [] }, scopeReport(ctx)).credentials).toBe(kept)
	})

	it("leaves out what the run did not have, and names creates nothing could remove", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		expect(finalResult(ctx, { principals: [] }, scopeReport(ctx))).not.toHaveProperty("interrupted")
		expect(finalResult(ctx, { principals: [] }, scopeReport(ctx)).teardown).toBeNull()
		ctx.ledger.unidentified("note", "notes.create", { method: "POST", seq: 7, status: 201, url: "u" } as Exchange)
		expect(finalResult(ctx, { principals: [] }, scopeReport(ctx)).teardown).toMatchObject({
			removed: 0,
			unidentified: [expect.objectContaining({ seq: 7 })],
		})
		ctx.state.teardown = { failed: [], records: [], removed: 3, unidentified: [], unsupported: [] }
		expect(finalResult(ctx, { principals: [] }, scopeReport(ctx)).teardown).toMatchObject({
			removed: 3,
			unidentified: [expect.objectContaining({ seq: 7 })],
		})
	})
})
