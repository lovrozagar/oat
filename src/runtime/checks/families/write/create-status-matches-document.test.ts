import { describe, expect, it } from "vitest"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { createStatusMatchesSpec } from "./create-status-matches-document.ts"
import { widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

function stage(respond: Responder, options: WidgetDocOptions = {}) {
	const model = modelOf(widgetDoc(options))
	return contextFor(model, "listWidgets", { respond, fields: { createOp: op(model, "createWidget") } })
}

/** What the transcript holds once the run's own create has gone through. */
async function created(ctx: ReturnType<typeof stage>["ctx"], path = "/widgets"): Promise<void> {
	await ctx.client.request("POST", path, { body: { name: "a" }, operationId: "createWidget" })
}

describe("create.status-matches-document", () => {
	it("passes a create that answers the status the document declares", async () => {
		const { ctx, findings } = stage(widgetApi())
		await created(ctx)
		expect(await runCheck(createStatusMatchesSpec, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports a create that answers 200 where the document declares 201", async () => {
		const { ctx, findings } = stage(() => ({ body: { id: "w1", name: "a" }, status: 200 }))
		await created(ctx)
		expect(await runCheck(createStatusMatchesSpec, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings).toHaveLength(1)
		expect(findings.findings[0]?.detail).toContain("createWidget returned 200; the document declares 201")
		expect(findings.findings[0]?.evidence[0]?.status).toBe(200)
	})

	it("is unresolved when no successful create on this path was observed", async () => {
		const { ctx, findings } = stage(() => ({ status: 500 }))
		await created(ctx)
		await created(ctx, "/other")
		const outcome = await runCheck(createStatusMatchesSpec, ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: "no successful create of this entity was observed" })
		expect(findings.inconclusive).toHaveLength(1)
	})

	it("stands down without a create, or without a documented success status", () => {
		const model = modelOf(widgetDoc())
		const { ctx } = contextFor(model, "listWidgets", { respond: widgetApi() })
		expect(createStatusMatchesSpec.plan(ctx).ok).toBe(false)
		const { ctx: undocumented } = stage(widgetApi(), { createStatus: "400" })
		expect(createStatusMatchesSpec.plan(undocumented)).toEqual({
			needs: "a success status documented for create",
			ok: false,
		})
	})
})
