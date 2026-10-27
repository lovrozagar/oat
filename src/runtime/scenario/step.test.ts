import { describe, expect, it } from "vitest"
import type { OutOfBandRequest } from "../../config/types/hooks.ts"
import type { ScenarioStep } from "../../config/types/steps.ts"
import { notes, runOf } from "./__fixtures__/stage.ts"
import { StepFailure } from "./failure.ts"
import { runStep } from "./step.ts"

describe("runStep: binds and requests", () => {
	it("binds names before the step, then sends it", async () => {
		const run = runOf(notes())
		await runStep(run, { bind: { label: "for {org}" }, body: { text: "{label}" }, operationId: "notes.create" }, 0)
		expect(run.scope["label"]).toBe("for o1")
		expect(run.requests[0]).toMatchObject({ method: "POST", options: { body: { text: "for o1" } }, path: "/notes" })
		await runStep(run, { bind: undefined, operationId: "notes.list" } as unknown as ScenarioStep, 1)
		expect(run.requests).toHaveLength(2)
	})
})

describe("runStep: a value delivered outside HTTP", () => {
	it("asks the hook for it, since the request that sent it", async () => {
		const asked: OutOfBandRequest[] = []
		const resolveOutOfBand = async (request: OutOfBandRequest) => {
			asked.push(request)
			return "123456"
		}
		const run = runOf(notes(), { hooks: { resolveOutOfBand }, outOfBand: { attempts: 1 } })
		await runStep(run, { body: { text: "a@b.c" }, operationId: "notes.create" }, 0)
		await runStep(run, { outOfBand: { address: "a@b.c", as: "code", kind: "otp" } }, 1)
		expect(run.scope["code"]).toBe("123456")
		expect(asked[0]).toMatchObject({ address: "a@b.c", kind: "otp", scope: { org: "o1" } })
		expect(asked[0]?.since).toBeTypeOf("number")
	})

	it("asks with no since for a value sent earlier, or one nothing here sent", async () => {
		const asked: OutOfBandRequest[] = []
		const run = runOf(notes(), {
			hooks: {
				resolveOutOfBand: async (request) => {
					asked.push(request)
					return "v"
				},
			},
		})
		await runStep(run, { body: { text: "a@b.c" }, operationId: "notes.create" }, 0)
		await runStep(run, { outOfBand: { address: "a@b.c", as: "early", kind: "otp", sentEarlier: true } }, 1)
		await runStep(run, { outOfBand: { address: "z@b.c", as: "other", kind: "otp" } }, 2)
		expect(asked.map((request) => request.since)).toEqual([undefined, undefined])
	})
})

describe("runStep: an external step", () => {
	it("binds what the hook returns, keeping JSON whole", async () => {
		const inputs: unknown[] = []
		const external = async (name: string, input: Record<string, unknown>) => {
			inputs.push(input)
			return name === "consent" ? ' {"id":"c1"}' : name === "broken" ? "{not json" : "plain"
		}
		const run = runOf(notes(), { hooks: { external } })
		run.objects.set("credential", { key: 1 })
		await runStep(run, { as: "grant", external: "consent", input: { credential: "{credential}", org: "{org}" } }, 0)
		await runStep(run, { as: "raw", external: "broken" }, 1)
		await runStep(run, { as: "word", external: "pay" }, 2)
		expect(inputs).toEqual([{ credential: { key: 1 }, org: "o1" }, {}, {}])
		expect(run.objects.get("grant")).toEqual({ id: "c1" })
		expect(run.objects.has("raw")).toBe(false)
		expect(run.scope).toMatchObject({ grant: ' {"id":"c1"}', raw: "{not json", word: "plain" })
	})

	it("sends a kept object whole as written, `{name}`-shaped text in it included, as a body and as input", async () => {
		const event = { id: "evt_1", url: "https://pay.test/done?session={CHECKOUT_SESSION_ID}&org={org}" }
		const inputs: unknown[] = []
		const external = async (name: string, input: Record<string, unknown>) => {
			inputs.push(input)
			return name === "stripe" ? JSON.stringify(event) : "ok"
		}
		const run = runOf(notes(), { hooks: { external } })
		await runStep(run, { as: "replay", external: "stripe" }, 0)
		await runStep(run, { body: "{replay}", operationId: "notes.create" }, 1)
		await runStep(run, { as: "seen", external: "check", input: { event: "{replay}" } }, 2)
		expect(run.requests[0]?.options.body).toEqual(event)
		expect(inputs[1]).toEqual({ event })
	})

	it("fails without the hook, or when it returns nothing", async () => {
		await expect(runStep(runOf(notes()), { as: "x", external: "pay" }, 2)).rejects.toThrow(
			new StepFailure('step 3 needs hooks.external for "pay"', [], []),
		)
		for (const answer of [null, ""]) {
			const run = runOf(notes(), { hooks: { external: async () => answer } })
			await expect(runStep(run, { as: "x", external: "pay" }, 0)).rejects.toThrow(
				'hooks.external("pay") returned nothing',
			)
		}
	})
})
