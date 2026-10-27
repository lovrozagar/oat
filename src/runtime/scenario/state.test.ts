import { describe, expect, it } from "vitest"
import { notesApi, notes, scenario, stage } from "./__fixtures__/stage.ts"
import { principalOf, startScenario } from "./state.ts"

describe("principalOf", () => {
	it("is the configured principal, and refuses one that is not", () => {
		const { input } = stage(notesApi(notes()))
		expect(principalOf(input, scenario([]), "beta").scope).toEqual({})
		expect(() => principalOf(input, scenario([]), "gamma")).toThrow(
			'oat: scenario "flow" names principal "gamma", which is not configured',
		)
	})
})

const sleep = async (): Promise<void> => undefined

describe("startScenario", () => {
	it("sends as the default principal, the parameters bound for it in scope from the start", () => {
		const { input } = stage(notesApi(notes()))
		const run = startScenario(input, scenario([]), sleep)
		expect(run.principal).toBe("alpha")
		expect(run.scope).toEqual({ org: "o1" })
		expect(run.context).toEqual({
			client: input.client,
			hooks: input.hooks,
			kept: run.objects,
			model: input.model,
			principalId: "alpha",
		})
		/* The steps' requests read the very map the steps keep values in. */
		expect(run.context.kept).toBe(run.objects)
		expect(run.sleep).toBe(sleep)
	})

	it("sends as the scenario's own principal, with the run's origins and out-of-band backoff", () => {
		const originClients = new Map()
		const { input } = stage(notesApi(notes()), { originClients, outOfBand: { attempts: 2 } })
		const run = startScenario(input, scenario([], { principal: "beta" }), async () => undefined)
		expect([run.principal, run.scope]).toEqual(["beta", {}])
		expect(run.context).toMatchObject({ originClients, outOfBand: { attempts: 2 }, principalId: "beta" })
	})
})
