import { describe, expect, it } from "vitest"
import type { Client } from "../../../../client/client.ts"
import type { Exchange } from "../../../exchange.ts"
import { exchange } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { refusing, stage, widgetsModel } from "./__fixtures__/widgets.ts"
import { declaredRateLimitHonoured } from "./spec-declared-rate-limit-is-honoured.ts"

type Pacing = Pick<Exchange, "rateLimitCategory" | "rateLimitHadRoom" | "rateLimitSource">

/** A recorded request to `operationId` that drew `status`, paced as `pacing` says. */
function sentTo(operationId: string | undefined, status: number, pacing: Pacing = {}): Exchange {
	return { ...exchange("GET", "/widgets", { status }, operationId === undefined ? {} : { operationId }), ...pacing }
}

const declaredRoom: Pacing = { rateLimitCategory: "reads", rateLimitHadRoom: true, rateLimitSource: "tag" }

/** The check run over `transcript`, with what it reported and the operations it said it judged. */
async function judge(transcript: Exchange[], withJudged = true) {
	const judged: string[][] = []
	const client = { exchangesForEntity: () => transcript } as unknown as Client
	const { ctx, findings } = stage(refusing(400), {
		client,
		...(withJudged ? { judged: (ids: readonly string[]) => judged.push([...ids]) } : {}),
	})
	return { findings, judged, outcome: await runCheck(declaredRateLimitHonoured, ctx) }
}

describe("spec.declared-rate-limit-is-honoured plan", () => {
	it("applies to an entity with an operation whose rate the document declares", () => {
		expect(declaredRateLimitHonoured.plan(stage(refusing(400)).ctx).ok).toBe(true)
	})

	it("stands down for an entity none of whose operations declares a rate", () => {
		expect(declaredRateLimitHonoured.plan(stage(refusing(400), { entityName: "gadget" }).ctx).ok).toBe(false)
	})

	it("names as subjects only the entity's operations with a declared rate", () => {
		const model = widgetsModel()
		const entity = model.entities.get("widget")
		if (entity === undefined) throw new Error("the widgets document has no widget entity")
		expect(declaredRateLimitHonoured.subjects?.(entity, model)).toEqual(["listWidgets"])
	})
})

describe("spec.declared-rate-limit-is-honoured run", () => {
	it("passes a transcript without a 429, judging only the operations with a declared rate", async () => {
		const { findings, judged, outcome } = await judge([
			sentTo("listWidgets", 200, declaredRoom),
			sentTo("listWidgets", 200),
			sentTo("createWidget", 201),
			sentTo("getWidget", 200),
			sentTo(undefined, 200),
			sentTo("unknownOperation", 200),
		])
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["listWidgets"]])
	})

	it("reports a declared rate refused while oat's bucket still had room, once per category", async () => {
		const writes: Pacing = { ...declaredRoom, rateLimitCategory: "writes" }
		const { findings, outcome } = await judge([
			...Array.from({ length: 4 }, () => sentTo("listWidgets", 429, declaredRoom)),
			sentTo("createWidget", 429, writes),
		])
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings.map((f) => [f.check, f.verdict, f.summary])).toEqual([
			["spec.declared-rate-limit-is-honoured", "SPEC_BUG", 'the declared "reads" rate limit is not honoured'],
			["spec.declared-rate-limit-is-honoured", "SPEC_BUG", 'the declared "writes" rate limit is not honoured'],
		])
		expect(findings.findings[0]?.detail).toContain('4 request(s) to the "reads" category returned 429')
		expect(findings.findings[0]?.evidence).toHaveLength(3)
		expect(findings.findings[1]?.evidence).toHaveLength(1)
	})

	it("groups a refusal with no category under unknown", async () => {
		const { rateLimitCategory: _, ...uncategorised } = declaredRoom
		const { findings } = await judge([sentTo("listWidgets", 429, uncategorised)])
		expect(findings.findings[0]?.summary).toBe('the declared "unknown" rate limit is not honoured')
	})

	it("ignores a 429 under a configured rate, or after oat's own bucket made the request wait", async () => {
		const { findings, outcome } = await judge(
			[
				sentTo("listWidgets", 429, { ...declaredRoom, rateLimitSource: "config" }),
				sentTo("listWidgets", 429, { ...declaredRoom, rateLimitHadRoom: false }),
				sentTo("listWidgets", 429, { rateLimitCategory: "reads", rateLimitSource: "tag" }),
			],
			false,
		)
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})
})
