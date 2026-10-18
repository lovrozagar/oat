import { describe, expect, it } from "vitest"
import { notesApi, notes, scenario, stage } from "./__fixtures__/stage.ts"
import { principalOf, startScenario, withObjects } from "./state.ts"

describe("principalOf", () => {
	it("is the configured principal, and refuses one that is not", () => {
		const { input } = stage(notesApi(notes()))
		expect(principalOf(input, scenario([]), "beta").roots).toEqual({})
		expect(() => principalOf(input, scenario([]), "gamma")).toThrow(
			'oat: scenario "flow" names principal "gamma", which is not configured',
		)
	})
})

const sleep = async (): Promise<void> => undefined

describe("startScenario", () => {
	it("sends as the default principal, its roots in scope from the start", () => {
		const { input } = stage(notesApi(notes()))
		const run = startScenario(input, scenario([]), sleep)
		expect(run.headers()).toEqual({ authorization: "Bearer alpha" })
		expect(run.scope).toEqual({ org: "o1" })
		expect(run.context).toEqual({ client: input.client, hooks: input.hooks, model: input.model, principalId: "alpha" })
		expect(run.sleep).toBe(sleep)
	})

	it("sends as the scenario's own principal, with the run's origins and out-of-band backoff", () => {
		const originClients = new Map()
		const { input } = stage(notesApi(notes()), { originClients, outOfBand: { attempts: 2 } })
		const run = startScenario(input, scenario([], { principal: "beta" }), async () => undefined)
		expect(run.headers()).toEqual({ authorization: "Bearer beta" })
		expect(run.context).toMatchObject({ originClients, outOfBand: { attempts: 2 }, principalId: "beta" })
	})
})

describe("withObjects", () => {
	it("replaces a field that is exactly `{name}` of a kept value, anywhere", () => {
		const kept = new Map<string, unknown>([
			["credential", { id: "c1" }],
			["count", 3],
		])
		const bytes = new Uint8Array([1, 2])
		expect(
			withObjects(kept, {
				bytes,
				list: ["{count}", "{other}", "x {count}"],
				nested: { value: "{credential}" },
				none: null,
				on: true,
			}),
		).toEqual({
			bytes,
			list: [3, "{other}", "x {count}"],
			nested: { value: { id: "c1" } },
			none: null,
			on: true,
		})
		expect(withObjects(kept, bytes)).toBe(bytes)
	})
})
