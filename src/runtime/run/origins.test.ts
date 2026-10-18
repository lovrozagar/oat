import { describe, expect, it } from "vitest"
import type { Exchange } from "../client.ts"
import type { RunContext } from "./context.ts"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { scopeReport } from "./result.ts"
import { runSecondaryOrigins } from "./origins.ts"
import type { RunOptions, RunResult } from "./types.ts"

/*
 * Secondary origins (one transport answers both hosts here): each has a client over its own document, and each runs as a run of its own,
 * with the primary's principals. What it finds joins the primary's result, named by origin.
 */

const OTHER = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }

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
		await other?.client.get("/notes")
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
				scenarios: [{ covers: [], id: "s-other", origin: "other", steps: [] } as never],
			}),
		)
		const coverage = scopeReport(ctx)
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage,
			persisted: [{ headers: { authorization: "Bearer alpha-key" }, id: "alpha", rank: 0, roots: {} }],
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]).toMatchObject({
			baseUrl: OTHER.baseUrl,
			cohortSize: 2,
			maxRps: 5,
			skipPrincipalTeardown: true,
			spec: OTHER.spec,
		})
		expect(asked[0]?.hooks).toEqual({})
		expect(asked[0]?.scenarios).toEqual([{ covers: [], id: "s-other", steps: [] }])
		expect(asked[0]?.principals.map((principal) => principal.id)).toEqual(["alpha"])
		expect(ctx.findings.findings.map((finding) => [finding.origin, finding.check])).toEqual([["other", "c.ran"]])
		expect(ctx.state.entitiesTested).toEqual(["other:note"])
		expect(ctx.state.checksSkipped).toEqual([{ check: "c.skip", entity: "other:note", needs: "n" }])
		expect(ctx.state.checksSuppressed[0]?.entity).toBe("other:note")
		expect(ctx.state.checksOutOfScope[0]?.entity).toBe("other:note")
		expect(ctx.findings.inconclusive.at(-1)).toMatchObject({ check: "c.inc", entity: "other:note" })
		expect(coverage.operations.at(-1)?.origin).toBe("other")
		expect(coverage.support.at(-1)).toMatchObject({ origin: "other" })
	})
})

describe("runSecondaryOrigins without", () => {
	it("passes no hooks to an origin when the primary has none", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { origins: [OTHER] }))
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage: scopeReport(ctx),
			persisted: [],
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]).not.toHaveProperty("hooks")
		expect(asked[0]).not.toHaveProperty("maxRps")
		expect(asked[0]).not.toHaveProperty("ops")
	})

	it("runs nothing for a run with no origins", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const asked: RunOptions[] = []
		await runSecondaryOrigins(ctx, {
			coverage: scopeReport(ctx),
			persisted: [],
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
			persisted: [],
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
			persisted: [],
			runOrigin: async (options) => {
				asked.push(options)
				return originResult(ctx)
			},
		})
		expect(asked[0]?.ops).toEqual(["notes.list"])
	})
})
