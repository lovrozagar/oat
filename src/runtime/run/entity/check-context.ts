import type { OperationModel } from "../../../spec/graph/types.ts"
import { type Actor, checkMemo, type WriteContext } from "../../checks/core/context.ts"
import { isolationOf } from "./actors.ts"
import { queryOf } from "./capabilities.ts"
import type { EntityRun, World } from "./state.ts"

/** The entity's operations as its checks may use them: an excluded route stands its checks down. */
interface Routes {
	readOp: OperationModel | undefined
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
	/** Each excluded by the profile, independently of the others. */
	readExcluded: boolean
	updateExcluded: boolean
	deleteExcluded: boolean
	inviteExcluded: boolean
}

/** What every check on the entity is given. */
export async function checkContext(run: EntityRun, world: World, actors: [Actor, ...Actor[]]): Promise<WriteContext> {
	const { ctx, entity, listOp } = run
	const routes = routesOf(run)
	const { capabilities, query } = await queryOf(run, world.scope.values)
	const isolation = isolationOf(actors)
	return {
		...declaredOps(run),
		...writeOps(run, world, routes),
		actors,
		altAuth: isolation?.headers,
		altScope: isolation?.scope,
		auth: ctx.principals.alpha.headers,
		capabilities,
		client: ctx.client.view({ purpose: "assertion", subject: entity.name }),
		collectionKey: listOp.collection?.key ?? null,
		createAcknowledged: world.createAcknowledged,
		entityName: entity.name,
		findings: ctx.findings,
		hooks: ctx.hooks,
		identity: entity.identity ?? "id",
		inScope: (op) => ctx.scope.inScope(op.operationId),
		invite: routes.inviteExcluded ? null : entity.invite,
		listOp,
		memo: checkMemo(ctx.state.runMemo),
		model: ctx.model,
		nonce: ctx.nonce,
		outOfBand: ctx.outOfBand,
		payloads: { policy: ctx.options.payloads ?? "per-write-path", ran: ctx.state.payloadPaths },
		query,
		recordCreated: ctx.principals.recordCreated,
		recordMoved: (name, id, reason) => ctx.ledger.moved(name, id, reason),
		recordUnidentified: ctx.principals.unidentified,
		records: world.records,
		scope: world.scope.values,
		seed: ctx.seed,
		softDelete: softDeleteOf(run),
		takenIdentities: run.taken,
		uniqueAdopted: world.uniqueAdopted,
		uniqueSets: entity.unique ?? [],
		uploads: ctx.uploads,
		validator: ctx.validator,
		...refreshOf(run),
	}
}

/* Checked independently of `degraded`: a profile can exclude one write route on an entity whose
 * create still ran cleanly, and that must not disable every other operation too. */
function routesOf({ ctx, entity }: EntityRun): Routes {
	const { model, exclusion } = ctx
	const readOp = model.byOperationId.get(entity.read ?? "")
	const updateOp = model.byOperationId.get(entity.update ?? "")
	const deleteOp = model.byOperationId.get(entity.delete ?? "")
	const inviteOp = entity.invite === null ? undefined : model.byOperationId.get(entity.invite.invite)
	/* In this order: each exclusion reports its gap the first time. */
	const readExcluded = exclusion.excludeOp(entity, readOp)
	const updateExcluded = exclusion.excludeOp(entity, updateOp)
	const deleteExcluded = exclusion.excludeOp(entity, deleteOp)
	const inviteExcluded = exclusion.excludeOp(entity, inviteOp)
	return { deleteExcluded, deleteOp, inviteExcluded, readExcluded, readOp, updateExcluded, updateOp }
}

/**
 * The write routes. In degraded mode oat did not write the records, so it has no oracle for them —
 * every write-path check sits out rather than assert against data it did not create. A
 * profile-excluded write route stands down the same way, independently.
 */
function writeOps(
	{ createOp, entity }: EntityRun,
	world: World,
	routes: Routes,
): Pick<WriteContext, "createOp" | "deleteOp" | "readOp" | "uniqueCreateOp" | "uniqueUpdateOp" | "updateOp"> {
	const { degraded, uniqueAdopted } = world
	const unique = (entity.unique?.length ?? 0) > 0 && (!degraded || uniqueAdopted)
	return {
		createOp: degraded ? undefined : createOp,
		deleteOp: degraded || routes.deleteExcluded ? undefined : routes.deleteOp,
		readOp: routes.readExcluded ? undefined : routes.readOp,
		uniqueCreateOp: unique ? createOp : undefined,
		uniqueUpdateOp: unique && !routes.updateExcluded ? routes.updateOp : undefined,
		updateOp: degraded || routes.updateExcluded ? undefined : routes.updateOp,
	}
}

/**
 * The entity's operations that declare async, effects or a wait. Narrowed to targets: these are
 * the subjects their checks invoke, and invoking an untargeted one is exactly the cost --ops exists
 * to skip.
 */
function declaredOps({ ctx, entity }: EntityRun): Pick<WriteContext, "asyncOps" | "effectOps" | "waitOps"> {
	const { model, exclusion, scope } = ctx
	const of = (declares: (op: OperationModel) => boolean): OperationModel[] =>
		model.operations.filter(
			(op) =>
				op.entity === entity.name && declares(op) && !exclusion.excludeOp(entity, op) && scope.inScope(op.operationId),
		)
	return {
		asyncOps: of((op) => op.async !== null),
		effectOps: of((op) => op.effects.length > 0),
		waitOps: of((op) => op.wait !== null),
	}
}

/* Taken from any operation on the entity, not just the list: authors naturally put x-soft-delete
 * on the delete route, and a tag that exists but is only read from list made
 * softdelete.absent-from-default-list stand down against a real document. */
function softDeleteOf({ ctx, entity, listOp }: EntityRun): string | null {
	return (
		ctx.model.operations.find((op) => op.entity === entity.name && op.softDelete !== null)?.softDelete ??
		listOp.softDelete
	)
}

function refreshOf({ ctx }: EntityRun): Pick<WriteContext, "refreshIfStale"> {
	const runtime = ctx.principals.alpha.runtime
	return runtime === undefined ? {} : { refreshIfStale: runtime.refreshIfStale }
}
