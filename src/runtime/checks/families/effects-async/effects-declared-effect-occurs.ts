import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { EffectSpec } from "../../../../spec/extensions/effects.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { type ActionBind, applyActionBind, bindActionScope, readActionBind, readBefore } from "../../../effects/bind.ts"
import { bindInstanceScope, canFillPath } from "../../../effects/scope.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { returnedId } from "../../../proven-id.ts"
import type { UploadContext } from "../../../upload.ts"
import { forEachInvocation } from "../../../upload-each.ts"
import { createdRecord } from "../../../world/created-record.ts"
import { type Record_ } from "../../../world/records.ts"
import type { WriteContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { encodeOpBody } from "../../payloads/body.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { type ActionRun, judgeEffects, missingParams, type Reporter, reportGap } from "./effect-verdicts.ts"
import { currentRecords, listOpFor, type Observation, observe } from "./observe.ts"
import { bodyForOp, forOperation } from "./requests.ts"

export const declaredEffectsOccur: Check = defineCheck({
	plan: (ctx) => when(ctx.effectOps.length > 0),
	/* An effect is counted by reading whole sets before and after, across pages. */
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	mutates: true,
	id: "effects.declared-effect-occurs",
	needs: "an operation declaring x-effects",
	subjects: subjectsOf.effects,
	async run(all): Promise<Outcome> {
		const tally: Tally = { judged: false }
		for (const op of all.effectOps) {
			const ctx = forOperation(all, op)
			await forEachInvocation(op.operationId, ctx.uploads, (uploads, slot) =>
				invokeAction({ check: this.id, ctx, fixture: slot?.filename, op, tally }, uploads),
			)
		}
		if (!tally.judged && tally.unjudged !== undefined) {
			return all.findings.unresolved(this.id, all.entityName, tally.unjudged)
		}
		return ASSERTED
	},
})

/**
 * Whether any action was invoked and its effects compared, and why not when none was: a run
 * that never saw an action succeed observed nothing about its effects.
 */
interface Tally {
	judged: boolean
	unjudged?: string
}

/** One invocation of one action declaring x-effects: what every step reports against. */
interface Invocation extends Reporter {
	tally: Tally
}

/** What the action's `x-bind` and `x-before` say about how to invoke it. */
interface Binding {
	actionBind: ActionBind | null
	beforeBody: unknown
}

/** Binds, observes, invokes and judges one action against the effects it declares. */
async function invokeAction(run: Invocation, uploads: UploadContext): Promise<void> {
	const { ctx, op } = run
	const effects = op.effects
	if (effects.length === 0) return

	const seeded = bindInstanceScope(ctx)
	const binding = await bindAction(run, uploads, seeded)
	if (binding === undefined) return
	const current = await currentRecords(ctx, seeded)
	const scope = bindActionScope({
		beforeBody: binding.beforeBody,
		bind: binding.actionBind,
		pathParams: op.pathParams,
		records: current,
		scope: seeded,
	})
	if (!canFillPath(op.path, scope)) {
		reportGap(run, `${op.operationId} could not be invoked`, missingParams(op.pathParams, scope))
		return
	}
	const befores = await observeBaselines(ctx, effects, scope)

	const invoked = await invoke(run, uploads, { binding, current, scope })
	if (invoked === undefined) return
	run.tally.judged = true
	const action: ActionRun = { ...run, befores, effects, invoked, scope }
	await judgeEffects(action)
}

/** The action's `x-bind`, and the body of its `x-before` prelude once that has run; `undefined` when it could not. */
async function bindAction(
	run: Invocation,
	uploads: UploadContext,
	scope: Record<string, string>,
): Promise<Binding | undefined> {
	const raw = run.ctx.model.rawOperations.get(run.op.operationId) as
		| { "x-bind"?: unknown; "x-before"?: unknown }
		| undefined
	const actionBind = readActionBind(raw?.["x-bind"])
	const beforeId = readBefore(raw?.["x-before"])
	if (beforeId === undefined) return { actionBind, beforeBody: undefined }
	const prelude = await runBefore(run, uploads, { operationId: beforeId, scope })
	return prelude === undefined ? undefined : { actionBind, beforeBody: prelude.responseBody }
}

/** The `x-before` prelude to run: its operation, and the path scope the action runs in. */
interface Prelude {
	operationId: string
	scope: Record<string, string>
}

/** Runs the `x-before` prelude; `undefined` once a prelude that could not run has been reported. */
async function runBefore(run: Invocation, uploads: UploadContext, prelude: Prelude): Promise<Exchange | undefined> {
	const { operationId: beforeId, scope } = prelude
	const { ctx, op } = run
	const beforeOp = ctx.model.byOperationId.get(beforeId)
	if (beforeOp === undefined) {
		reportGap(
			run,
			`${op.operationId} names x-before "${beforeId}", which is not an operation`,
			"the action was not invoked",
		)
		return undefined
	}
	const beforeScope = bindActionScope({
		beforeBody: undefined,
		bind: null,
		pathParams: beforeOp.pathParams,
		records: ctx.records,
		scope,
	})
	if (!canFillPath(beforeOp.path, beforeScope)) {
		reportGap(
			run,
			`${op.operationId} could not run x-before "${beforeId}"`,
			missingParams(beforeOp.pathParams, beforeScope),
		)
		return undefined
	}
	const beforeFields = beforeOp.hasRequestBody ? bodyForOp(ctx, beforeOp) : undefined
	const beforeInvoked = await ctx.client.request(beforeOp.method, fillPath(beforeOp.path, beforeScope), {
		as: { principal: ctx.actor.id },
		operationId: beforeOp.operationId,
		...(beforeFields === undefined
			? {}
			: await encodeOpBody(ctx, beforeOp, beforeFields, { variant: "baseline", index: 0, uploads })),
	})
	if (beforeInvoked.status >= 400) {
		reportGap(run, `${beforeId} (x-before) returned ${beforeInvoked.status}`, `${op.operationId} was not invoked`)
		return undefined
	}
	await recordPrelude(ctx, beforeOp, beforeInvoked, beforeScope)
	return beforeInvoked
}

/**
 * A prelude that creates is the run's to remove. One through the entity's own create is
 * already tracked; an invite is not, since an invite POST is never an entity's create.
 */
async function recordPrelude(
	ctx: WriteContext,
	beforeOp: OperationModel,
	beforeInvoked: Exchange,
	beforeScope: Record<string, string>,
): Promise<void> {
	const made = beforeOp.action === "create" ? ctx.model.entities.get(beforeOp.entity ?? "") : undefined
	if (made === undefined || made.delete === undefined || beforeInvoked.status >= 300) return
	const created = await createdRecord({
		client: ctx.client,
		createOp: beforeOp,
		exchange: beforeInvoked,
		model: ctx.model,
		principal: ctx.actor.id,
		scope: beforeScope,
		sent: beforeInvoked.requestBody,
		wants: "id",
	})
	const id = created === null ? undefined : returnedId(created.record, made.identity ?? "id")
	if (id === undefined) ctx.recordUnidentified?.(made.name, beforeOp.operationId, beforeInvoked)
	else ctx.recordCreated?.({ entity: made.name, id, scope: { ...beforeScope } }, beforeInvoked.principal)
}

/** Each effect's collection as it is before the action, read once per entity. */
async function observeBaselines(
	ctx: WriteContext,
	effects: readonly EffectSpec[],
	scope: Record<string, string>,
): Promise<Map<string, Observation>> {
	const befores = new Map<string, Observation>()
	for (const effect of effects) {
		const listOp = listOpFor(ctx, effect.entity)
		if (listOp === undefined) continue
		if (befores.has(effect.entity)) continue
		befores.set(effect.entity, await observe(ctx, listOp, scope))
	}
	return befores
}

/** The action's request, or `undefined` once an action that did not succeed has been reported. */
async function invoke(
	run: Invocation,
	uploads: UploadContext,
	at: { binding: Binding; current: readonly Record_[]; scope: Record<string, string> },
): Promise<Exchange | undefined> {
	const { ctx, op, fixture } = run
	const prepared = applyActionBind(
		at.binding.actionBind,
		{ records: at.current, beforeBody: at.binding.beforeBody },
		op.hasRequestBody ? bodyForOp(ctx, op) : undefined,
	)
	const body = prepared.body
	const invoked = await ctx.client.request(op.method, fillPath(op.path, at.scope), {
		as: { principal: ctx.actor.id },
		operationId: op.operationId,
		...(fixture === undefined ? {} : { fixture }),
		...(Object.keys(prepared.query).length === 0 ? {} : { query: prepared.query }),
		...(body === undefined ? {} : await encodeOpBody(ctx, op, body, { variant: "baseline", index: 0, uploads })),
	})
	if (standDownForFeatureGate(ctx, op, invoked, run.check)) return undefined
	if (standDownForRateLimit(ctx, invoked, run.check)) return undefined
	if (invoked.status < 400) return invoked
	reportGap(
		run,
		`${op.operationId} could not be invoked`,
		`returned ${invoked.status}; its declared effects are unverified`,
	)
	/* A crash is the backend failing; a refusal more likely means oat's request was wrong. */
	if (invoked.status >= 500) {
		run.tally.unjudged ??= `${op.operationId} returned ${invoked.status}, so its declared effects were never observed`
	}
	return undefined
}
