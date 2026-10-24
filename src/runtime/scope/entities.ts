/** Which entities a run can seed and check, and which operations their checks grade. */

import { effective } from "../../spec/collection/effective.ts"
import { successSchema } from "../../spec/collection/responses.ts"
import { schemaAt } from "../checks/payloads/item-schema.ts"
import type { PrincipalsConfig, Recipe, SecurityConfig } from "../../config/types/security.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { OperationObject } from "../../spec/types.ts"
import { entityChecks } from "../checks/core/registry.ts"
import { CHECKS } from "../checks/registry.ts"
import { revokeOperationId } from "../../credentials/anchors.ts"

/** Union of every check's subjects for this entity. */
export function staticSubjects(entity: EntityModel, model: SpecModel): Set<string> {
	const ids = new Set<string>()
	for (const check of entityChecks(CHECKS)) for (const id of check.subjects(entity, model)) ids.add(id)
	return ids
}

/** The operations security recipes send, and which of them mint a credential (not an account). */
export type AuthOperations = ReadonlySet<string> & { readonly mints?: ReadonlySet<string> }

/**
 * operationIds a security recipe names, the base recipes' and each principal's own: the steps a login
 * or refresh sends, a login's revoke, a mint's operation and its revoke. They are credential
 * operations: their creates already ran when the principals signed in. `mints` names the mints, whose
 * entity the lanes still test on records of their own, the minted ones guarded.
 */
export function authStepOperationIds(config: {
	security?: SecurityConfig
	principals?: PrincipalsConfig
}): Set<string> & { mints: Set<string> } {
	const recipes: Array<Partial<Recipe>> = [
		...Object.values(config.security ?? {}),
		...Object.values(config.principals ?? {}).flatMap((principal) => Object.values(principal.security ?? {})),
	]
	const ids = Object.assign(new Set<string>(), { mints: new Set<string>() })
	for (const recipe of recipes) {
		if (recipe.mint !== undefined) ids.mints.add(recipe.mint.operationId)
		for (const id of recipeOperations(recipe)) ids.add(id)
	}
	return ids
}

/* Every operation one recipe sends: its login and refresh steps', its revoke, and its mint and the mint's revoke. */
function recipeOperations(recipe: Partial<Recipe>): string[] {
	const steps = [...(recipe.login?.steps ?? []), ...(recipe.refresh?.steps ?? [])]
	const sent = steps.flatMap((step) => ("operationId" in step ? [step.operationId] : []))
	const others = [revokeOperationId(recipe.login?.revoke), recipe.mint?.operationId, recipe.mint?.revoke]
	return [...sent, ...others.filter((id): id is string => id !== undefined)]
}

/**
 * The operation of `entity` a security recipe calls, which makes it a credential entity, one the auth
 * flow owns. A create a recipe sends is a sign-up, whose account the lanes read back, so a create alone
 * never makes one. `undefined` for any other entity.
 */
export function credentialOperation(entity: EntityModel, authCreates: ReadonlySet<string>): string | undefined {
	return [entity.list, ...(entity.reads ?? [entity.read]), entity.update, entity.delete, ...entity.actions].find(
		(id) => id !== undefined && authCreates.has(id),
	)
}

/* A create a recipe sends signs an account up; a mint only makes a credential, and the lanes may send it too. */
export function createIsAuthProvisioned(createOp: OperationModel, authCreates: AuthOperations): boolean {
	const id = createOp.operationId
	return createOp.freshPrincipal || (authCreates.has(id) && authCreates.mints?.has(id) !== true)
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
 * `plan` all leave such an entity out. An entity a recipe calls stays in: the guard keeps the records
 * holding its credentials from every check (`credential-records.ts`), as long as the mint that makes
 * them answers each one's id. Register-as-create with no item route is the auth flow, not a fixture.
 */
export function authOwnedReason(
	entity: EntityModel,
	model: SpecModel,
	authCreates: ReadonlySet<string>,
): string | null {
	const createOp = entity.create === undefined ? undefined : model.byOperationId.get(entity.create)
	const minted = createOp !== undefined && authCreates.has(createOp.operationId)
	if (minted && credentialOperation(entity, authCreates) !== undefined && !answersAnId(createOp, model, entity)) {
		return (
			`"${entity.name}" holds credentials a security recipe mints with ${createOp.operationId}, ` +
			"whose answer names no id to protect them by, so no check may"
		)
	}
	const authProvisioned = createOp !== undefined && createIsAuthProvisioned(createOp, authCreates)
	if (authProvisioned && entity.read === undefined) {
		return `"${entity.name}" is created by the auth flow and has no item route`
	}
	return null
}

/* The headers a documented response declares, by name. */
function headersOf(answer: unknown): string[] {
	return Object.keys((answer as { headers?: object }).headers ?? {})
}

/* Whether a create's documented answer names the record's id: a declared source, the identity in its record, or a Location. */
function answersAnId(createOp: OperationModel, model: SpecModel, entity: EntityModel): boolean {
	if (createOp.createdIdFrom !== null) return true
	const raw = model.rawOperations.get(createOp.operationId) as OperationObject
	const responses = Object.entries(raw.responses ?? {}).filter(([code]) => code.startsWith("2"))
	if (responses.some(([, answer]) => headersOf(answer).some((name) => name.toLowerCase() === "location"))) return true
	const answer = effective(successSchema(raw))
	const record = createOp.recordPath === null ? answer : schemaAt(answer, createOp.recordPath)
	return Object.hasOwn(record?.properties ?? {}, entity.identity ?? "id")
}

/**
 * What a cohort of `entity` lacks: none with a list and a create whose records oat can identify,
 * or, with no list, a create oat may send, an item read and an identity. With no list the creates
 * are the cohort, each record found again by its item read.
 */
function cohortGaps(entity: EntityModel, model: SpecModel, authCreates: ReadonlySet<string>): string[] {
	const unidentified = entity.trackable ? [] : ["records oat can identify after create"]
	/* A list with no create is a cohort already (`testableOtherwise`): this one has neither. */
	if (entity.create === undefined) return ["list operation", "create operation"]
	if (entity.list !== undefined) return unidentified
	/* An entity's create is one of the model's operations. */
	if (createIsAuthProvisioned(model.byOperationId.get(entity.create) as OperationModel, authCreates)) {
		return ["list operation", "create other than the sign-up the auth flow sends"]
	}
	return entity.read === undefined ? ["list operation", "read operation", ...unidentified] : unidentified
}

/**
 * Why an entity cannot be seeded and checked, or `null` when it can. The one answer a run, `doctor`
 * and `plan` all give.
 */
export function untestableEntityReason(
	entity: EntityModel,
	model: SpecModel,
	authCreates: ReadonlySet<string>,
): string | null {
	const owned = authOwnedReason(entity, model, authCreates)
	if (owned !== null) return owned
	if (testableOtherwise(entity, model)) return null
	const missing = cohortGaps(entity, model, authCreates)
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
