import type { EntityModel, OperationModel } from "../../../spec/graph/types.ts"
import { rootReadIds } from "../../root-read.ts"
import { createIsAuthProvisioned, staticSubjects } from "../../scope/entities.ts"
import { entityIsSelf } from "../../self/operations.ts"
import type { RunContext } from "../context.ts"
import { takenOf } from "../state.ts"
import { actorsOf } from "./actors.ts"
import { checkContext } from "./check-context.ts"
import { runChecks } from "./check-loop.ts"
import { rootRead } from "./root-read.ts"
import { type SeedPlan, seedWorld } from "./seed.ts"
import { selfIdentity } from "./self.ts"
import type { EntityRun } from "./state.ts"

/**
 * Tests one entity: seeds its world, gives every principal its scope, resolves what its list can
 * query, and runs its checks. An entity with no list is tested by its root read or as the caller.
 */
export async function testEntity(ctx: RunContext, entity: EntityModel): Promise<void> {
	const listOp = ctx.model.byOperationId.get(entity.list ?? "")
	if (listOp === undefined) {
		if (rootReadIds(entity).length > 0) return rootRead(ctx, entity)
		if (entityIsSelf(entity)) return selfIdentity(ctx, entity)
		return
	}
	if (ctx.network.gate.exhausted) return
	/* No fallback for a list route itself: every other check on this entity is reached through
	 * it, so its exclusion is the whole entity's, not one operation's. */
	if (ctx.exclusion.excludeOp(entity, listOp)) return
	const run = entityRun(ctx, entity, listOp)
	ctx.progress.check = undefined
	ctx.progress.tick({
		entity: entity.name,
		entityIndex: ctx.progress.entityIndex,
		entityTotal: ctx.progress.entityTotal,
		message: "seeding",
		phase: "seed",
		requests: ctx.progress.requests,
	})
	const world = await seedWorld(run, seedPlan(run))
	if (world === null) return
	const context = await checkContext(run, world, await actorsOf(run, world))
	ctx.state.entitiesTested.push(entity.name)
	await runChecks(run, context)
}

/** One entity under test, before its seeding: its routes, its targets, and its own scratch state. */
export function entityRun(ctx: RunContext, entity: EntityModel, listOp: OperationModel): EntityRun {
	const { model, scope, findings, principals, state } = ctx
	const createOp = model.byOperationId.get(entity.create ?? "")
	/* Targets this entity's checks can grade. Seeding findings land on them: under --ops a seed
	 * that fails leaves exactly these ungraded, and the report has to say which. */
	const targets =
		scope.mode === "full"
			? createOp === undefined
				? []
				: [createOp.operationId]
			: [...staticSubjects(entity, model)].filter((id) => scope.inScope(id))
	const taken = takenOf(state, entity.name)
	return {
		ancestors: { creating: new Map(), made: new Map() },
		createOp,
		ctx,
		entity,
		findings: targets.length === 0 ? findings : findings.attributed(targets),
		index: [...model.entities.keys()].indexOf(entity.name),
		listOp,
		lostVariants: [],
		roots: { ...principals.alpha.scope },
		seeding: ctx.client.view({ purpose: "seed", subject: entity.name }),
		taken,
	}
}

function seedPlan({ ctx, entity, createOp }: EntityRun): SeedPlan {
	const inviteOnly = entity.invite !== null && createOp === undefined
	return {
		authProvisioned: createOp !== undefined && createIsAuthProvisioned(createOp, ctx.authCreates),
		inviteOnly,
		/* A listable entity with no create can still run an action that declares x-effects. The
		 * owner row is already there; the action's x-before makes the row it needs. */
		needsListedCohort:
			createOp === undefined &&
			!inviteOnly &&
			entity.actions.some((id) => {
				const action = ctx.model.byOperationId.get(id)
				return action !== undefined && action.effects.length > 0 && ctx.scope.inScope(id)
			}),
	}
}
