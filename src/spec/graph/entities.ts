/** Entities gathered from the operations that name them, each with its lifecycle operations. */

import { identityRank } from "./identity.ts"
import type { EntityModel, OperationModel } from "./types.ts"

/** Files every operation that names an entity and an action under that entity. */
export function registerOperations(entities: Map<string, EntityModel>, operations: readonly OperationModel[]): void {
	const identityRanks = new Map<string, number>()
	for (const op of operations) {
		if (op.entity === null || op.action === null) continue
		const entity = entityNamed(entities, op.entity)
		/* Declared beats an item route, which beats a collection's guess: teardown deletes through the item route. */
		if (op.identity !== null && identityRank(op.identitySource) > (identityRanks.get(entity.name) ?? -1)) {
			entity.identity = op.identity
			identityRanks.set(entity.name, identityRank(op.identitySource))
		}
		adopt(entity, op)
		assignAction(entity, op)
	}
}

/** The entity called `name`, created empty the first time it is named. */
export function entityNamed(entities: Map<string, EntityModel>, name: string): EntityModel {
	const existing = entities.get(name)
	if (existing !== undefined) return existing
	const created: EntityModel = {
		actions: [],
		declaredSurface: [],
		identity: null,
		invite: null,
		name,
		readSurface: [],
		tenantParams: [],
		trackable: false,
		unique: null,
	}
	entities.set(name, created)
	return created
}

/** Takes on what an operation says about its entity: tenancy, invites and unique sets. */
function adopt(entity: EntityModel, op: OperationModel): void {
	if (op.tenantParam !== null && !entity.tenantParams.includes(op.tenantParam)) {
		entity.tenantParams.push(op.tenantParam)
	}
	if (entity.invite === null && op.invite !== null) entity.invite = op.invite
	if (op.unique !== null && (op.action === "create" || entity.unique === null)) entity.unique = op.unique
}

function assignAction(entity: EntityModel, op: OperationModel): void {
	switch (op.action) {
		case "create":
			/* An invite POST looks like a collection create. Seeding it invents a grantee
			 * (usually a junk email) and the real invite check never runs. */
			if (op.invite !== null) break
			entity.create = op.operationId
			break
		case "list":
			entity.list = op.operationId
			break
		case "read":
			entity.reads ??= []
			if (!entity.reads.includes(op.operationId)) entity.reads.push(op.operationId)
			entity.read ??= op.operationId
			break
		case "update":
			entity.update = op.operationId
			break
		case "delete":
			entity.delete = op.operationId
			break
		case "action":
			entity.actions.push(op.operationId)
			break
	}
}
