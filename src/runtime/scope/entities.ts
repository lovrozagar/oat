/** Which entities a run can seed and check, and which operations their checks grade. */

import type { PrincipalsConfig, Recipe, SecurityConfig } from "../../config/types/security.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { CHECKS } from "../checks/registry.ts"

/** Union of every check's subjects for this entity. */
export function staticSubjects(entity: EntityModel, model: SpecModel): Set<string> {
	const ids = new Set<string>()
	for (const check of CHECKS) for (const id of check.subjects(entity, model)) ids.add(id)
	return ids
}

/**
 * operationIds a recipe's login or refresh steps send, the base recipes' and each principal's own:
 * those creates already ran when the principals signed in.
 */
export function authStepOperationIds(config: {
	security?: SecurityConfig
	principals?: PrincipalsConfig
}): Set<string> {
	const recipes: Array<Partial<Recipe>> = [
		...Object.values(config.security ?? {}),
		...Object.values(config.principals ?? {}).flatMap((principal) => Object.values(principal.security ?? {})),
	]
	const ids = new Set<string>()
	for (const recipe of recipes) {
		for (const step of [...(recipe.login?.steps ?? []), ...(recipe.refresh?.steps ?? [])]) {
			if ("operationId" in step) ids.add(step.operationId)
		}
	}
	return ids
}

export function createIsAuthProvisioned(createOp: OperationModel, authCreates: ReadonlySet<string>): boolean {
	return createOp.freshPrincipal || authCreates.has(createOp.operationId)
}

/** An entity testable without a list-and-create cohort, for what else it has. */
function testableOtherwise(entity: EntityModel, model: SpecModel): boolean {
	if (entity.invite !== null && entity.list !== undefined) return true
	/* The signed-up caller is the record. A read or an update is enough. */
	if (entity.identity === "self" && (entity.read !== undefined || entity.update !== undefined)) return true
	/* The path id is the caller's root, already bound at signup. */
	if (entity.identity === "root" && entity.read !== undefined) return true
	/* An action that declares x-effects can run against rows the list already returns.
	 * The action's x-before creates the row the list does not have yet. An action id names an
	 * operation of the model. */
	if (
		entity.list !== undefined &&
		entity.actions.some((id) => (model.byOperationId.get(id) as OperationModel).effects.length > 0)
	) {
		return true
	}
	/* A list with no create is still a cohort: the rows already there are the records. */
	return entity.list !== undefined && entity.create === undefined
}

/**
 * Why the auth flow, not the lanes, owns `entity`, or `null` when it does not. A run, `doctor` and
 * `plan` all leave such an entity out: register-as-create with no item route is the auth flow, not
 * a fixture.
 */
export function authOwnedReason(
	entity: EntityModel,
	model: SpecModel,
	authCreates: ReadonlySet<string>,
): string | null {
	const createOp = entity.create === undefined ? undefined : model.byOperationId.get(entity.create)
	const authProvisioned = createOp !== undefined && createIsAuthProvisioned(createOp, authCreates)
	if (authProvisioned && entity.read === undefined) {
		return `"${entity.name}" is created by the auth flow and has no item route`
	}
	return null
}

/** Why an entity cannot be seeded and checked, or `null` when it can. */
export function untestableEntityReason(
	entity: EntityModel,
	model: SpecModel,
	authCreates: ReadonlySet<string>,
): string | null {
	const owned = authOwnedReason(entity, model, authCreates)
	if (owned !== null) return owned
	if (testableOtherwise(entity, model)) return null
	const missing = [
		...(entity.list === undefined ? ["a list operation"] : []),
		...(entity.create === undefined ? ["a create operation"] : []),
		...(entity.list !== undefined && entity.create !== undefined && !entity.trackable
			? ["records oat can identify after create"]
			: []),
	]
	return missing.length === 0 ? null : `"${entity.name}" has no ${missing.join(" and no ")}`
}

export function testableEntities(model: SpecModel, authCreates: ReadonlySet<string>): EntityModel[] {
	return [...model.entities.values()]
		.filter((entity) => untestableEntityReason(entity, model, authCreates) === null)
		.sort((a, b) => a.name.localeCompare(b.name))
}

/** Why an operation can never be graded: no entity owns it, its entity cannot be tested, or no check judges it. */
export function untestableReason(op: OperationModel, model: SpecModel, authCreates: ReadonlySet<string>): string {
	if (op.entity === null) {
		return `unmodeled: no entity owns ${op.method.toUpperCase()} ${op.path}`
	}
	/* An operation that names an entity also has an action under it, so the model has the entity. */
	const why = untestableEntityReason(model.entities.get(op.entity) as EntityModel, model, authCreates)
	if (why !== null) return `entity-not-testable: ${why}`
	return `no-applicable-check: no check judges ${op.operationId}`
}
