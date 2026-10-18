import type { EffectSpec } from "../../../../spec/extensions/effects.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { describeEffectHold, effectHolds } from "../../../effects/cardinality.ts"
import { bindAfterCreateEffects, bindCreatedScope, identityPathParam } from "../../../effects/scope.ts"
import { listedIds } from "../../../proven-id.ts"
import type { WriteContext } from "../../core/context.ts"
import { listOpFor, type Observation, observe } from "./observe.ts"
import { subject } from "./requests.ts"

/*
 * What effects.declared-effect-occurs concludes once the action has succeeded: each declared
 * effect's collection read again and compared, record by record, with the baseline read before it.
 */

/** Where findings about one invocation of one action land. */
export interface Reporter {
	check: string
	ctx: WriteContext
	op: OperationModel
	fixture: string | undefined
}

/** One action that succeeded, with the baselines its effects are judged against. */
export interface ActionRun extends Reporter {
	effects: readonly EffectSpec[]
	befores: ReadonlyMap<string, Observation>
	invoked: Exchange
	/** Path parameters bound so far; a created parent's id is added as it is learned. */
	scope: Record<string, string>
}

type Seen = Extract<Observation, { status: "ok" }>

/** A gap on the invocation's subject. */
export function reportGap(run: Reporter, title: string, detail: string): void {
	run.ctx.findings.gap(run.check, subject(run.ctx.entityName, run.op.operationId, run.fixture), {
		summary: title,
		detail,
		fixture: run.fixture,
	})
}

/** `missing {a}, {b}`: the parameters `scope` cannot fill. */
export function missingParams(params: readonly string[], scope: Record<string, string>): string {
	const missing = params.filter((name) => scope[name] === undefined)
	return `missing ${missing.map((name) => `{${name}}`).join(", ")}`
}

/** Judges every declared effect of a succeeded action. */
export async function judgeEffects(action: ActionRun): Promise<void> {
	const deltas = new Map<string, string[]>()
	Object.assign(
		action.scope,
		bindAfterCreateEffects(action.ctx.model, action.effects, action.invoked.responseBody, deltas),
	)
	await bindCreatedParents(action, deltas)
	for (const effect of action.effects) await judgeEffect(action, effect)
}

/**
 * A created parent the response does not name is found in its collection's delta, so a later
 * effect's list path — the parent's children — can be filled.
 */
async function bindCreatedParents(action: ActionRun, deltas: Map<string, string[]>): Promise<void> {
	const { ctx, scope } = action
	for (const effect of action.effects) {
		if (effect.op !== "create") continue
		const param = identityPathParam(ctx.model, effect.entity)
		if (scope[param] !== undefined) continue
		const listOp = listOpFor(ctx, effect.entity)
		if (listOp === undefined) continue
		const afterParent = await observe(ctx, listOp, scope)
		if (afterParent.status !== "ok") continue
		const before = action.befores.get(effect.entity)
		const prior = before?.status === "ok" ? before.ids : []
		const added = afterParent.ids.filter((id) => !prior.includes(id))
		deltas.set(effect.entity, added)
		Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, action.invoked.responseBody, added))
	}
}

async function judgeEffect(action: ActionRun, effect: EffectSpec): Promise<void> {
	const { ctx, op, scope, invoked } = action
	const after = await observeAfter(action, effect)
	if (after === undefined) return

	const before = action.befores.get(effect.entity)
	if (before?.status === "error") {
		reportGap(
			action,
			`${op.operationId} could not observe "${effect.entity}" before the write`,
			`${before.reason}; no baseline, so the effect is unverified`,
		)
		return
	}
	const prior = before?.status === "ok" ? before.ids : []
	const added = after.ids.filter((id) => !prior.includes(id))
	const removed = prior.filter((id) => !after.ids.includes(id))
	/* Records the operation made on oat's behalf are oat's to remove. */
	if (effect.op === "create" || effect.op === "append") {
		for (const id of listedIds(added)) ctx.recordCreated?.(effect.entity, id, { ...scope }, invoked.principal)
	}

	if (effectHolds(effect, after.ids.length - prior.length, added.length, removed.length)) {
		if (effect.op === "create") {
			Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, invoked.responseBody, added))
		}
		return
	}
	reportUnheld(action, effect, { added: added.length, after, prior: prior.length, removed: removed.length })
}

/** The effect's collection after the write, or `undefined` once a collection that could not be read is reported. */
async function observeAfter(action: ActionRun, effect: EffectSpec): Promise<Seen | undefined> {
	const { ctx, op, scope } = action
	const listOp = listOpFor(ctx, effect.entity)
	if (listOp === undefined) {
		reportGap(
			action,
			`${op.operationId} declares an effect on "${effect.entity}", which has no list route`,
			"the effect cannot be observed, so it is not verified",
		)
		return undefined
	}
	const after = await observe(ctx, listOp, scope)
	if (after.status === "unfillable") {
		reportGap(
			action,
			`${op.operationId} declares an effect on "${effect.entity}", but the list path cannot be filled`,
			`${missingParams(listOp.pathParams, scope)} after the write; the effect is unverified`,
		)
		return undefined
	}
	if (after.status === "error") {
		reportGap(
			action,
			`${op.operationId} could not observe "${effect.entity}" after the write`,
			`${after.reason}; the declared effect is unverified`,
		)
		return undefined
	}
	return after
}

/** A declared effect that did not hold: the collection changed by other than what was declared. */
function reportUnheld(
	action: ActionRun,
	effect: EffectSpec,
	sizes: { prior: number; after: Seen; added: number; removed: number },
): void {
	const { ctx, op, invoked, fixture } = action
	const where = subject(ctx.entityName, op.operationId, fixture)
	const evidence = [invoked, sizes.after.exchange]
	const now = sizes.after.ids.length
	if (effect.op === "create" || effect.op === "append") {
		ctx.findings.backend(action.check, where, {
			summary: `${op.operationId} did not produce the "${effect.entity}" records it declares`,
			detail:
				`x-effects declares ${describeEffectHold(effect)} on "${effect.entity}", but the ` +
				`collection went from ${sizes.prior} to ${now} ` +
				`(${sizes.added} added, ${sizes.removed} removed). A declared effect that does ` +
				"not occur means callers cannot rely on the operation having done anything.",
			evidence,
			fixture,
		})
		return
	}
	if (effect.op === "delete") {
		ctx.findings.backend(action.check, where, {
			summary: `${op.operationId} did not remove the "${effect.entity}" records it declares`,
			detail:
				`x-effects declares ${describeEffectHold(effect)} on "${effect.entity}", but the collection ` +
				`went from ${sizes.prior} to ${now}`,
			evidence,
			fixture,
		})
		return
	}
	ctx.findings.backend(action.check, where, {
		summary: `${op.operationId} changed the size of "${effect.entity}" while declaring ${effect.op}`,
		detail:
			`x-effects declares ${effect.op}, which must not add or remove records, but the ` +
			`collection went from ${sizes.prior} to ${now}`,
		evidence,
		fixture,
	})
}
