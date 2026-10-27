import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import type { RunContext } from "./context.ts"
import { contextOf, notesApi, openDoc, optionsFor, servingAt } from "./__fixtures__/api.ts"
import { scopeReport } from "./result.ts"
import { runSecondaryOrigins } from "./origins.ts"
import type { RunOptions, RunResult } from "./types.ts"

/*
 * Secondary origins (one transport answers both hosts here): each has a client over its own document,
 * and each runs as a run of its own over the primary's store, with the principals that signed in.
 * What it finds joins the primary's result, named by origin.
 */

/* The other host serves the notes document too, so its bearer scheme sends the primary's. */
const OTHER = {
	baseUrl: "http://other.test",
	id: "other",
	security: { bearer: "bearer" },
	spec: "http://other.test/openapi.json",
}

/** A host whose document declares no security, so nothing of the primary's is mapped to it. */
const OPEN = { baseUrl: "http://open.test", id: "open", spec: "http://open.test/openapi.json" }

/** A secondary run's result, as `run` would give it. */
function originResult(ctx: RunContext): RunResult {
	const scope = scopeReport(ctx)
	return {
		checkNotes: [],
		checkTimings: [],
		checksOutOfScope: [{ check: "c.out", entity: "note" }],
		checksRun: ["c.ran"],
		checksSkipped: [{ check: "c.skip", entity: "note", needs: "n" }],
		checksSuppressed: [{ because: "c.ran", check: "c.sup", entity: "note" }],
		client: ctx.client,
		created: 0,
		entitiesTested: ["note"],
		findings: [
			{ check: "c.ran", detail: "d", entity: "note", evidence: [] as Exchange[], summary: "s", verdict: "BACKEND_BUG" },
		],
		inconclusive: [{ check: "c.inc", entity: "note", reason: "why" }],
		model: ctx.model,
		principals: [],
		profile: "full",
		profileExclusions: [],
		scope: {
			...scope,
			operations: [{ ...(scope.operations[0] as (typeof scope.operations)[number]) }],
			support: [{ operationId: "notes.list", usedBy: ["c.ran"] } as never],
		},
		teardown: null,
	}
}

describe("loadOriginClients", () => {
	it("gives each origin a client over its own document, paced and fenced like the primary", async () => {
		const asked: string[] = []
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				hooks: {
					beforeRequest: (request) => {
						asked.push(request.url)
						return { allow: true }
					},
					resolveHeaders: async () => ({ "x-from": "hook" }),
				},
				origins: [
					{ ...OTHER, maxRps: 100, overlay: { info: { title: "other" } } as never },
					{ ...OTHER, id: "plain" },
				],
			}),
		)
		const other = ctx.originClients.get("other")
		expect(other?.model.entities.has("note")).toBe(true)
		await other?.client.get("/notes", { as: { principal: "alpha" } })
		expect(asked.at(-1)).toBe("http://other.test/notes")
		expect(ctx.originClients.has("plain")).toBe(true)
	})
})

describe("runSecondaryOrigins", () => {
	it("runs each origin with the primary's principals and options, and folds in what it found", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				cohortSize: 2,
				hooks: { teardownPrincipal: async () => undefined },
				origins: [{ ...OTHER, maxRps: 5 }],
				principals: {
					alpha: { fresh: false, rank: 2, scope: { org_id: "o1" } },
					blocked: { security: { bearer: { login: { from: "$.t", steps: [{ operationId: "nope" }] } } } },
				},
				redact: { headers: ["x-tester-key"] },
				scenarios: [{ covers: [], id: "s-other", origin: "other", steps: [] } as never],
			}),
		)
		const coverage = scopeReport(ctx)
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage,
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]).toMatchObject({
			baseUrl: OTHER.baseUrl,
			cohortSize: 2,
			maxRps: 5,
			redact: { headers: ["x-tester-key"] },
			security: { bearer: { static: "alpha-key" } },
			sharedCredentials: { mapping: { bearer: "bearer" }, originOnly: new Set(), store: ctx.store },
			skipPrincipalTeardown: true,
			spec: OTHER.spec,
		})
		expect(asked[0]?.hooks).toEqual({})
		expect(asked[0]?.scenarios).toEqual([{ covers: [], id: "s-other", steps: [] }])
		/* Signed in already, none signed up again, and the BLOCKED one left out. */
		expect(asked[0]?.principals).toEqual({ alpha: { rank: 2, scope: { org_id: "o1" } } })
		expect(ctx.findings.findings.map((finding) => [finding.origin, finding.check])).toEqual([
			[undefined, "auth.blocked"],
			["other", "c.ran"],
		])
		expect(ctx.state.entitiesTested).toEqual(["other:note"])
		expect(ctx.state.checksSkipped).toEqual([{ check: "c.skip", entity: "other:note", needs: "n" }])
		expect(ctx.state.checksSuppressed[0]?.entity).toBe("other:note")
		expect(ctx.state.checksOutOfScope[0]?.entity).toBe("other:note")
		expect(ctx.findings.inconclusive.at(-1)).toMatchObject({ check: "c.inc", entity: "other:note" })
		expect(coverage.operations.at(-1)?.origin).toBe("other")
		expect(coverage.support.at(-1)).toMatchObject({ origin: "other" })
	})
})

describe("loadOriginClients with nothing to map", () => {
	it("gives an origin with no mapping an adapter that sends nothing, in a run that names no recipe", async () => {
		const { security: _none, ...bare } = optionsFor(notesApi(), { origins: [OPEN] })
		const ctx = await contextOf(servingAt(bare, OPEN.spec, openDoc()))
		const answer = await ctx.originClients.get("open")?.client.get("/notes", { as: { principal: "alpha" } })
		expect(answer?.requestHeaders["authorization"]).toBeUndefined()
	})
})

describe("runSecondaryOrigins without", () => {
	it("passes no hooks to an origin when the primary has none, nor a mapping it does not declare", async () => {
		const ctx = await contextOf(servingAt(optionsFor(notesApi(), { origins: [OPEN] }), OPEN.spec, openDoc()))
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage: scopeReport(ctx),
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]).not.toHaveProperty("hooks")
		expect(asked[0]?.sharedCredentials?.mapping).toEqual({})
		expect(asked[0]).not.toHaveProperty("maxRps")
		expect(asked[0]).not.toHaveProperty("ops")
	})

	it("runs nothing for a run with no origins", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage: scopeReport(ctx),
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked).toEqual([])
	})
})

describe("runSecondaryOrigins targeted", () => {
	it("skips an origin a targeted run names no operation of", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { ops: ["notes.list"], origins: [OTHER] }))
		const coverage = scopeReport(ctx)
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage,
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked).toEqual([])
		expect(coverage.originsSkipped).toEqual(["other"])
	})

	it("targets an origin's own operations when a targeted run names them", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { ops: ["other:notes.list"], origins: [OTHER] }))
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage: scopeReport(ctx),
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]?.ops).toEqual(["notes.list"])
	})
})
