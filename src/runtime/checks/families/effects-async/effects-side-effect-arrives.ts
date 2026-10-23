import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { WaitSpec } from "../../../../spec/extensions/async.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { bindAfterCreateEffects, bindMissingPathParams } from "../../../effects/scope.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { UploadContext } from "../../../upload.ts"
import { forEachInvocation } from "../../../upload-each.ts"
import { driveWait } from "../../../wait.ts"
import type { CheckContext, WriteContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { encodeOpBody } from "../../payloads/body.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { bodyForOp, forOperation, subject } from "./requests.ts"

/**
 * After a write that declares `x-wait`, poll the named GET until a JSON path is occupied
 * (or `awaitSideEffect` returns true). Timeout is a backend finding, not a coverage gap.
 */
export const sideEffectArrives: Check = defineCheck({
	plan: (ctx) => when(ctx.waitOps.length > 0),
	dependsOn: ["list.read-after-write"],
	mutates: true,
	id: "effects.side-effect-arrives",
	needs: "an operation declaring x-wait",
	subjects: subjectsOf.waits,
	async run(all): Promise<Outcome> {
		for (const op of all.waitOps) {
			const ctx = forOperation(all, op)
			const spec = op.wait
			if (spec === null) continue
			const pollOp = ctx.model.byOperationId.get(spec.operationId)
			if (pollOp === undefined) {
				ctx.findings.gap(this.id, ctx.entityName, {
					summary: `${op.operationId} x-wait names "${spec.operationId}", which is not in the document`,
					detail: "the side effect cannot be observed, so it is not verified",
				})
				continue
			}

			await forEachInvocation(op.operationId, ctx.uploads, (uploads, slot) =>
				invokeAndWait({ check: this.id, ctx, fixture: slot?.filename, op, pollOp, spec }, uploads),
			)
		}
		return ASSERTED
	},
})

/** One invocation of one write declaring x-wait: what every step reports against. */
interface Invocation {
	check: string
	ctx: WriteContext
	op: OperationModel
	pollOp: OperationModel
	spec: WaitSpec
	fixture: string | undefined
}

/** Invokes the write, then polls its x-wait operation until the side effect shows or time runs out. */
async function invokeAndWait(run: Invocation, uploads: UploadContext): Promise<void> {
	const { ctx, op, pollOp, spec, fixture } = run
	const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
	const invoked = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
		as: { principal: ctx.actor.id },
		operationId: op.operationId,
		...(fixture === undefined ? {} : { fixture }),
		...(body === undefined ? {} : await encodeOpBody(ctx, op, body, { variant: "baseline", index: 0, uploads })),
	})
	if (standDownForFeatureGate(ctx, op, invoked, run.check)) return
	if (standDownForRateLimit(ctx, invoked, run.check)) return
	if (invoked.status >= 400) {
		ctx.findings.gap(run.check, subject(ctx.entityName, op.operationId, fixture), {
			summary: `${op.operationId} could not be invoked`,
			detail: `returned ${invoked.status}; its declared x-wait is unverified`,
			fixture,
		})
		return
	}

	const scope = bindWaitScope(ctx, op, pollOp, invoked.responseBody)
	const outcome = await driveWait({
		awaitSideEffect: ctx.hooks.awaitSideEffect,
		client: ctx.client,
		pollOp,
		principal: ctx.actor.id,
		record: invoked.responseBody,
		scope,
		spec,
		writeOpId: op.operationId,
	})
	if (!outcome.timedOut) return
	ctx.findings.backend(run.check, subject(ctx.entityName, op.operationId, fixture), {
		summary: `${op.operationId} side effect did not appear within ${spec.timeoutMs}ms`,
		detail:
			`x-wait polls ${spec.operationId}` +
			(spec.until === undefined ? "" : ` until ${spec.until} is non-empty`) +
			` and the path was still empty after ${outcome.polls} poll(s) / ${Math.round(outcome.elapsedMs)}ms. ` +
			"Queue consumers and webhook inboxes are not the same request; a timeout here is a " +
			"missed delivery, not a coverage gap.",
		evidence: [invoked, ...outcome.exchanges.slice(-2)],
		fixture,
	})
}

function bindWaitScope(
	ctx: CheckContext,
	writeOp: OperationModel,
	pollOp: OperationModel,
	writeBody: unknown,
): Record<string, string> {
	const scope = { ...ctx.scope }
	Object.assign(scope, bindAfterCreateEffects(ctx.model, writeOp.effects, { body: writeBody }))
	Object.assign(scope, bindMissingPathParams(pollOp.pathParams, scope, writeBody))
	return scope
}
