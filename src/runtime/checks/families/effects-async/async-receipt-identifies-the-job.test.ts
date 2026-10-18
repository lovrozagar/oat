import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../../spec/graph.ts"
import { ASSERTED } from "../../../finding.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import type { WriteContext } from "../../core/context.ts"
import { baseDocument, routes, withOperation } from "./__fixtures__/documents.ts"
import { asyncReceiptIsResolvable as check } from "./async-receipt-identifies-the-job.ts"

/*
 * The check judges traffic other checks already sent: each test sends the start through the fake
 * client first, as the async lifecycle check would, then asks this one about the transcript.
 */

const doc = withOperation(baseDocument(), "/jobs", "post", {
	operationId: "startJob",
	"x-async": { idFrom: "$.job.id", poll: "getJob" },
})
withOperation(doc, "/orgs/{org}/jobs", "post", {
	operationId: "startOrgJob",
	"x-async": { idFrom: "$.id", poll: "getJob" },
})
withOperation(doc, "/exports", "post", { operationId: "startExport", "x-async": { poll: "getJob" } })
const model = modelOf(doc)
const startJob = op(model, "startJob")

async function judged(
	respond: Responder,
	send: (ctx: WriteContext) => Promise<unknown>,
	asyncOps: OperationModel[] = [startJob],
) {
	const stage = contextFor(model, "listWidgets", respond, { asyncOps })
	await send(stage.ctx)
	const outcome = await check.run(stage.ctx, undefined)
	return { ...stage, outcome }
}

const start = (ctx: WriteContext, path = "/jobs", operationId = "startJob") =>
	ctx.client.request("POST", path, { operationId })

const acknowledged = () => ({ body: {}, status: 202 })

describe("plan", () => {
	it("applies only when some async operation names where its job id is", () => {
		const plan = (asyncOps: OperationModel[]) =>
			check.plan(contextFor(model, "listWidgets", () => undefined, { asyncOps }).ctx).ok
		expect(plan([])).toBe(false)
		expect(plan([op(model, "startExport")])).toBe(false)
		expect(plan([op(model, "startExport"), startJob])).toBe(true)
	})
})

describe("run, on one start", () => {
	it("passes a receipt that carries the declared job id", async () => {
		const { outcome, findings } = await judged(() => ({ body: { job: { id: "j1" } }, status: 202 }), start)
		expect(outcome).toBe(ASSERTED)
		expect(findings.findings).toEqual([])
	})

	it("fails a receipt that omits the job id it declares, with the receipt as evidence", async () => {
		const { findings } = await judged(() => ({ body: { job: {} }, status: 202 }), start)
		expect(findings.findings).toMatchObject([
			{
				check: "async.receipt-identifies-the-job",
				evidence: [{ status: 202, url: "http://api.test/jobs" }],
				operations: ["startJob"],
				summary: "startJob response does not carry the job identifier it declares",
				verdict: "SPEC_BUG",
			},
		])
		expect(findings.findings[0]?.detail).toContain('x-async names "$.job.id" as the job id')
	})

	it("fails a null job id as an absent one", async () => {
		const { findings } = await judged(() => ({ body: { job: { id: null } }, status: 202 }), start)
		expect(findings.findings.map((f) => f.verdict)).toEqual(["SPEC_BUG"])
	})
})

describe("run, among several exchanges", () => {
	it("judges the first successful start, not an earlier refusal", async () => {
		let calls = 0
		const respond = () => (calls++ === 0 ? { status: 409 } : { body: { job: { id: "j1" } }, status: 202 })
		const { findings } = await judged(respond, async (ctx) => {
			await start(ctx)
			await start(ctx)
		})
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("ignores the operation's exchanges on another path", async () => {
		const respond = routes({ "POST /jobs/other": () => ({ body: {}, status: 202 }) })
		const { findings } = await judged(respond, (ctx) => start(ctx, "/jobs/other"))
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it.each([
		[500, "startJob answered 500, so there was no receipt to read"],
		[0, "startJob answered nothing, so there was no receipt to read"],
	])("leaves the check unresolved when the start answered %s", async (status, reason) => {
		const { findings, outcome } = await judged(() => ({ status }), start)
		expect(outcome).toBe(ASSERTED)
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([{ check: check.id, entity: "widget", operations: ["startJob"], reason }])
	})

	it("says nothing when the operation was never started", async () => {
		const { findings } = await judged(
			() => undefined,
			async () => undefined,
		)
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("skips operations without an id pointer, or whose path the scope cannot fill", async () => {
		const { findings } = await judged(
			acknowledged,
			async (ctx) => {
				await start(ctx, "/exports", "startExport")
				await start(ctx, "/orgs/o1/jobs", "startOrgJob")
			},
			[op(model, "startExport"), op(model, "startOrgJob"), { ...startJob, async: null }],
		)
		expect(findings.findings).toEqual([])
	})
})
