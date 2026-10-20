/**
 * Seeds the world once per run: resolves path parameters top-down, then creates a discriminating
 * cohort per entity.
 *
 * Prior art resolved fixtures per test case, which meant one unseedable resource produced dozens
 * of unrelated failures. Here a resolution failure is recorded once and everything downstream is
 * reported as BLOCKED against that single cause.
 */

import { owningEntityOf } from "../../spec/graph/roots.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { returnedId } from "../proven-id.ts"
import { SeedError } from "../seed-error.ts"
import { createOne } from "./ancestor-create.ts"
import type { Scope, Seeding } from "./types.ts"

/** The create that makes the record a path parameter names. */
interface Ancestor {
	param: string
	owner: string
	entity: EntityModel
	createOp: OperationModel
}

/** The create behind `param`, or the reason oat cannot make the record it names. */
function ancestorOf(op: OperationModel, model: SpecModel, param: string): Ancestor {
	const owner = owningEntityOf(model.operations, op.path, param)
	if (owner === null) {
		throw new SeedError(param, `path parameter {${param}} names no entity oat can create`)
	}
	const entity = model.entities.get(owner)
	if (entity?.create === undefined) {
		throw new SeedError(
			param,
			`{${param}} identifies a "${owner}", which has no create operation — supply it as a root`,
		)
	}
	/* A create id names an operation of the model. */
	const createOp = model.byOperationId.get(entity.create) as OperationModel
	/* A create whose own path names the record it makes (`PUT /things/{thing_id}`): resolving
	 * the parameter through it would resolve the same create again, without end. */
	if (createOp.pathParams.includes(param)) {
		throw new SeedError(
			param,
			`{${param}} names the "${owner}" ${createOp.operationId} makes, so oat cannot seed it; ` +
				"supply it as a root or create it in a scenario",
		)
	}
	return { createOp, entity, owner, param }
}

/** An ancestor, and the key its id is shared under: one per principal and parent path. */
interface KeyedAncestor extends Ancestor {
	cacheKey: string
}

/** Makes the ancestor, reports it, and keeps its id for every later scope that needs the same one. */
async function makeAncestor(ancestor: KeyedAncestor, seeding: Seeding, scope: Scope): Promise<string> {
	const { options } = seeding
	const { cacheKey, owner, param } = ancestor
	const { record: created, adopted } = await createOne(ancestor.createOp, seeding, scope)
	const identity = ancestor.entity.identity ?? "id"
	const id = returnedId(created, identity)
	if (id === undefined) {
		throw new SeedError(param, `create for "${owner}" returned no usable "${identity}"`)
	}
	/* Adopted, not created: somebody else's record, never oat's to remove. */
	if (!adopted) options.onCreate?.(owner, id, { ...scope.values })
	options.ancestors?.made.set(cacheKey, id)
	return id
}

/**
 * Resolves every path parameter an operation needs. Roots come from config; everything else is
 * created through the owning entity's create operation, depth-first.
 */
export async function resolvePathScope(
	op: OperationModel,
	seeding: Seeding,
	scope: Scope = { created: [], values: {} },
): Promise<Scope> {
	const { options } = seeding
	for (const param of op.pathParams) {
		if (scope.values[param] !== undefined) continue

		const fromRoot = options.roots[param]
		if (fromRoot !== undefined) {
			scope.values[param] = fromRoot
			continue
		}

		const ancestor = ancestorOf(op, seeding.model, param)
		const { createOp } = ancestor
		await resolvePathScope(createOp, seeding, scope)
		/* One ancestor per principal and parent path: a row and its siblings share the table oat
		 * made for the first of them, instead of each leaving another table behind. */
		const cacheKey = `${options.principal}\u0000${createOp.operationId}\u0000${fillPath(createOp.path, scope.values)}`
		const cached = options.ancestors?.made.get(cacheKey)
		if (cached !== undefined) {
			scope.values[param] = cached
			continue
		}
		/* Entities in parallel lanes can reach the same missing ancestor at once; the second
		 * waits for the first's create rather than making a twin. */
		const pending = options.ancestors?.creating.get(cacheKey)
		if (pending !== undefined) {
			scope.values[param] = await pending
			continue
		}
		const creating = makeAncestor({ ...ancestor, cacheKey }, seeding, scope)
		options.ancestors?.creating.set(cacheKey, creating)
		try {
			scope.values[param] = await creating
		} finally {
			options.ancestors?.creating.delete(cacheKey)
		}
		scope.created.push({
			entity: ancestor.owner,
			id: scope.values[param] as string,
			path: fillPath(createOp.path, scope.values),
		})
	}
	return scope
}
