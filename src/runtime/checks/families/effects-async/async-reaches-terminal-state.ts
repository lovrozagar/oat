import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { AsyncSpec } from "../../../../spec/extensions/async.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { type AsyncOutcome, driveAsync, inspectStreamAsync, matchesPredicate } from "../../../async.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { receiptId } from "../../../proven-id.ts"
import type { UploadContext } from "../../../upload.ts"
import { forEachInvocation } from "../../../upload-each.ts"
import type { WriteContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { encodeOpBody } from "../../payloads/body.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { isEventStream, subjectsOf } from "../../planning/subjects.ts"
import { bodyForOp, forOperation, subject } from "./requests.ts"

export const asyncReachesTerminalState: Check = defineCheck({
	plan: (ctx) => when(ctx.asyncOps.length > 0),
	mutates: true,
	id: "async.reaches-terminal-state",
	needs: "an operation declaring x-async",
	subjects: subjectsOf.async,
	async run(all): Promise<Outcome> {
		for (const op of all.asyncOps) {
			const ctx = forOperation(all, op)
			const spec = op.async
			if (spec === null) continue

			await forEachInvocation(op.operationId, ctx.uploads, (uploads, slot) =>
				watchJob({ check: this.id, ctx, fixture: slot?.filename, op, spec }, uploads),
			)
		}
		return ASSERTED
	},
})

/** One invocation of one async operation: what every step reports against. */
interface Invocation {
	check: string
	ctx: WriteContext
	op: OperationModel
	spec: AsyncSpec
	fixture: string | undefined
}

function about(run: Invocation): string {
	return subject(run.ctx.entityName, run.op.operationId, run.fixture)
}

/** Starts one job and follows it — through its stream, or by polling — to a terminal state. */
async function watchJob(run: Invocation, uploads: UploadContext): Promise<void> {
	const { ctx, op, spec } = run
	const start = await startJob(run, uploads)
	if (start === undefined) return

	const streamed = isEventStream(start, op)
	const fromStream = streamed ? inspectStreamAsync(start.responseBody, spec) : null
	if (fromStream?.terminal !== null && fromStream?.terminal !== undefined) {
		judgeStreamedTerminal(run, fromStream.terminal)
		return
	}

	const receipt =
		fromStream?.idRecord !== null && fromStream?.idRecord !== undefined ? fromStream.idRecord : start.responseBody
	if (streamed && fromStream !== null && (fromStream.id === undefined || fromStream.id === null)) {
		ctx.findings.backend(run.check, about(run), {
			summary: `${op.operationId} job disappeared before completing`,
			detail: "the stream ended without a terminal frame and without a job id, so the poll route cannot be named.",
			evidence: [start],
			fixture: run.fixture,
		})
		return
	}

	const outcome = await driveAsync({
		client: ctx.client,
		operation: (operationId) => ctx.model.byOperationId.get(operationId),
		principal: ctx.actor.id,
		receipt,
		scope: ctx.scope,
		spec,
		start,
	})
	recordJob(run, receipt, start)
	judgePolled(run, start, outcome)
}

/** The start request, or `undefined` once a start that began no job has been reported. */
async function startJob(run: Invocation, uploads: UploadContext): Promise<Exchange | undefined> {
	const { ctx, op } = run
	const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
	const start = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
		as: { principal: ctx.actor.id },
		...(body === undefined ? {} : await encodeOpBody(ctx, op, body, { variant: "baseline", index: 0, uploads })),
	})
	if (standDownForFeatureGate(ctx, op, start, run.check)) return undefined
	/* A start that crashed started nothing: the lifecycle cannot be judged, and the crash
	 * itself is failed by the server-error rule. Say so rather than stand down quietly. */
	if (start.status === 0 || start.status >= 500) {
		ctx.findings.unresolved(
			run.check,
			about(run),
			`${op.operationId} answered ${start.status === 0 ? "nothing" : start.status}, so no job was started to watch`,
		)
		return undefined
	}
	if (start.status >= 400) {
		ctx.findings.gap(run.check, about(run), {
			summary: `${op.operationId} could not be started`,
			detail: `returned ${start.status}; the async lifecycle after it is untested`,
			fixture: run.fixture,
		})
		return undefined
	}
	return start
}

function judgeStreamedTerminal(run: Invocation, terminal: Record<string, unknown>): void {
	const { successWhen } = run.spec
	if (successWhen === undefined || matchesPredicate(terminal, successWhen)) return
	run.ctx.findings.gap(run.check, about(run), {
		summary: `${run.op.operationId} reached a non-success terminal state`,
		detail: `terminal state did not satisfy "${successWhen}"; downstream effects of this operation are untested`,
		fixture: run.fixture,
	})
}

/** The job this start created is a record like any other, and oat's to remove. */
function recordJob(run: Invocation, receipt: unknown, start: Exchange): void {
	const { ctx, op, spec } = run
	const jobId = spec.idFrom === undefined ? undefined : receiptId(receipt, spec.idFrom)
	const polled = (ctx.model.byRoute.get(spec.poll) ?? ctx.model.byOperationId.get(spec.poll))?.entity
	if (polled === null || polled === undefined) return
	/* A receipt that names no id still made a job, and nothing can remove it. */
	if (jobId === undefined) ctx.recordUnidentified?.(polled, op.operationId, start)
	else ctx.recordCreated?.({ entity: polled, id: jobId, scope: { ...ctx.scope } }, start.principal)
}

function judgePolled(run: Invocation, start: Exchange, outcome: AsyncOutcome): void {
	const { ctx, op, spec } = run
	if (outcome.state === "timed-out") {
		ctx.findings.backend(run.check, about(run), {
			summary: `${op.operationId} never reached a terminal state`,
			detail:
				`polled ${spec.poll} ${outcome.polls} time(s) over ${Math.round(outcome.elapsedMs)}ms ` +
				`without satisfying "${spec.until ?? "any terminal state"}". A job that neither ` +
				"completes nor fails leaves callers polling forever.",
			evidence: [start, ...outcome.exchanges.slice(-2)],
			fixture: run.fixture,
		})
		return
	}
	if (outcome.state === "unfillable") {
		/* oat could not name the job to ask about it: nothing the backend did. */
		ctx.findings.unresolved(
			run.check,
			about(run),
			`the poll route ${spec.poll} could not be filled from the receipt: ${outcome.unfillable}`,
		)
		return
	}
	if (outcome.state === "vanished") {
		ctx.findings.backend(run.check, about(run), {
			summary: `${op.operationId} job disappeared before completing`,
			detail:
				`the poll route stopped serving the job after ${outcome.polls} poll(s). A job that ` +
				"vanishes is indistinguishable from one that never existed.",
			evidence: [start, ...outcome.exchanges.slice(-2)],
			fixture: run.fixture,
		})
		return
	}
	if (outcome.succeeded) return
	ctx.findings.gap(run.check, about(run), {
		summary: `${op.operationId} reached a non-success terminal state`,
		detail: `terminal state did not satisfy "${outcome.unmet}"; downstream effects of this operation are untested`,
		fixture: run.fixture,
	})
}
