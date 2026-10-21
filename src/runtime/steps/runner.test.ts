import { describe, expect, expectTypeOf, it } from "vitest"
import type { StepRunner } from "../../credentials/ports.ts"
import { stepStage } from "./__fixtures__/flows.ts"
import { stepRunner } from "./runner.ts"

describe("stepRunner", () => {
	it("serves the credentials StepRunner port", () => {
		expectTypeOf(stepRunner).returns.toExtend<StepRunner>()
	})

	it("runs a principal's steps from its scope and hands back the scope and the last answer", async () => {
		const { ctx, sent } = stepStage(() => ({ body: { token: "t1" }, headers: { "x-h": "1" }, status: 200 }))
		const { principalId: _, ...shared } = ctx
		const runner = stepRunner(shared)
		const out = await runner.run(
			[{ body: { user: "{who}" }, operationId: "auth.token", saveAs: { token: "$.token" } }],
			{
				principal: "bob",
				scope: { who: "b" },
			},
		)
		expect(out).toEqual({
			answer: { body: { token: "t1" }, cookies: {}, headers: { "x-h": "1" }, status: 200 },
			scope: { token: "t1", who: "b" },
		})
		expect(sent[0]?.options.body).toEqual({ user: "b" })
	})

	it("sends a real exchange of each step, and labels every hop a probe only when asked, as a replay is", async () => {
		const { ctx, sent } = stepStage(() => ({ body: { token: "t1" }, status: 200 }))
		const runner = stepRunner(ctx)
		await runner.run([{ operationId: "auth.token" }], { principal: "bob", scope: {} })
		await runner.run([{ operationId: "auth.token" }, { operationId: "auth.token" }], {
			principal: "bob",
			probe: true,
			scope: {},
		})
		expect(sent.map((request) => request.options.probe)).toEqual([undefined, true, true])
	})

	it("labels a failure with the principal it ran for", async () => {
		const { ctx } = stepStage(() => ({ status: 500 }))
		await expect(stepRunner(ctx).run([{ operationId: "ping" }], { principal: "bob", scope: {} })).rejects.toThrow(
			'oat: principal "bob" failed at auth step 1 (GET /ping)',
		)
	})

	it("refuses steps that send no request, since there is no answer to read", async () => {
		const { ctx } = stepStage(() => ({ status: 200 }))
		await expect(stepRunner(ctx).run([], { principal: "bob", scope: {} })).rejects.toThrow(
			'oat: principal "bob" ran its steps without sending a request, so there is no answer to read',
		)
	})
})
