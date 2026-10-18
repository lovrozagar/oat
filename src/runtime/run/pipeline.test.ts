import { describe, expect, it } from "vitest"
import { flow, notesApi, notesDoc, optionsFor, unreachable, withLogin } from "./__fixtures__/api.ts"
import { run } from "./pipeline.ts"

/*
 * The whole run, stage after stage, against a correct in-memory notes API: what it seeds it
 * removes, what it tests it reports, and the stages run in order.
 */

describe("run", () => {
	it("tests a correct API end to end, removing everything it created", async () => {
		const rows: Array<Record<string, unknown>> = []
		const phases: string[] = []
		const options = optionsFor(notesApi(notesDoc(), rows), {
			onProgress: (snap) => {
				if (phases.at(-1) !== snap.phase) phases.push(snap.phase)
			},
		})
		const result = await run(options)
		expect(result.entitiesTested).toEqual(["note"])
		expect(result.checksRun.length).toBeGreaterThan(10)
		expect(result.created).toBeGreaterThan(0)
		expect(result.teardown?.removed).toBe(result.created)
		expect(rows).toEqual([])
		expect(phases).toEqual([
			"load",
			"auth",
			"seed",
			"test",
			"teardown",
			"scenario",
			"test",
			"contract",
			"teardown",
			"done",
		])
		expect(options.seen[0]).toMatchObject({ method: "GET", path: "/openapi.json" })
		expect(result.principals).toEqual([expect.objectContaining({ id: "alpha" })])
		expect(result.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([])
	})

	it("returns at once, with the outage, when the network goes away while signing in", async () => {
		const served = optionsFor(withLogin(), { principals: [flow] })
		const serve = served.network?.fetch as typeof fetch
		const offAfterLoad: typeof fetch = (input, init) =>
			String(input).endsWith("/openapi.json") ? serve(input, init) : unreachable(input, init)
		const result = await run({ ...served, network: { ...served.network, fetch: offAfterLoad } })
		expect(result).toMatchObject({ entitiesTested: [], principals: [], teardown: null })
		expect(result.network?.kind).toBe("refused")
	})
})

describe("run with secondary origins", () => {
	it("runs each secondary origin, and reports one that stops on an unexpected error", async () => {
		const origin = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }
		const broken = { covers: [], id: "broken", origin: "other", steps: [{ operationId: "no.such" }] }
		const result = await run(optionsFor(notesApi(), { origins: [origin], scenarios: [broken] as never }))
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				check: "run.error",
				entity: "origins",
				summary: "the secondary origins stopped on an unexpected error",
			}),
		)
	})

	it("leaves secondary origins and provisioned accounts to the primary run", async () => {
		const origin = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }
		const options = optionsFor(notesApi(), { origins: [origin], skipPrincipalTeardown: true })
		const result = await run(options)
		/* Its document is read to plan the run; nothing else is sent to it. */
		expect(options.seen.filter((request) => request.host === "other.test").map((request) => request.path)).toEqual([
			"/openapi.json",
		])
		expect(result.entitiesTested).toEqual(["note"])
	})
})
