/** Who is asking, and what they may reach: credentials, roles, tenancy and the path's parents. */

import type { EntityDef } from "../model/types.ts"
import type { Row } from "../store-api.ts"
import { HttpError } from "./errors.ts"
import { hiddenFromCreator, tombstoned } from "./records.ts"
import type { EntityCall, ItemCall } from "./handlers/entity.ts"
import {
	type EntityRecord,
	type Grant,
	type Principal,
	type ReferenceState,
	type Scope,
	TENANT_FIELD,
} from "./state.ts"
import type { ReferenceRequest } from "./wire.ts"

const notFound = (entity: EntityDef, id: unknown, why = "does not exist"): HttpError =>
	new HttpError(404, "not_found", `${entity.name} ${String(id)} ${why}`)

/** The bearer value a request carries, or `undefined`: what the conformance's own small backends read. */
export function bearer(request: ReferenceRequest): string | undefined {
	const header = request.headers.authorization
	return header?.startsWith("Bearer ") === true ? header.slice(7).trim() : undefined
}

/** Viewer cannot write; member cannot delete; admin can do everything. Under ROLE_NOT_CHECKED anyone can. */
export function assertWrite(state: ReferenceState, principal: Principal, kind: "create" | "update" | "delete"): void {
	if (state.defects.has("ROLE_NOT_CHECKED")) return
	if (kind === "update" && state.defects.has("ROLE_WRITE_INVERTED")) {
		/* The lattice turned over for updates: the viewer may, the member may not. */
		if (principal.rank === 1) throw new HttpError(403, "forbidden", "role cannot write")
		if (principal.rank === 0) return
	}
	if (kind === "delete" && principal.rank < 2) throw new HttpError(403, "forbidden", "role cannot delete")
	if (kind !== "delete" && principal.rank < 1) throw new HttpError(403, "forbidden", "role cannot write")
}

/** A path under another tenant's project is not the caller's. */
export function assertTenant(principal: Principal, projectId: string | number | undefined): void {
	if (projectId !== undefined && projectId !== principal.projectId) {
		throw new HttpError(403, "forbidden", "resource belongs to another tenant")
	}
}

function parentOf(state: ReferenceState, param: string): EntityDef | undefined {
	return state.entities.find((candidate) => candidate.itemParam === param)
}

/** Walks a record up its parent chain to the owning tenant, driven by the descriptors. */
export async function ownedByTenant(
	state: ReferenceState,
	{ entity, record }: EntityRecord,
	principal: Principal,
): Promise<boolean> {
	if (entity.fields.some((f) => f.name === TENANT_FIELD)) return record[TENANT_FIELD] === principal.projectId
	for (const param of entity.parents) {
		const parentEntity = parentOf(state, param)
		const link = record[param]
		if (parentEntity === undefined || (typeof link !== "string" && typeof link !== "number")) continue
		const parent = await state.store.byId(parentEntity, link)
		return parent !== null && ownedByTenant(state, { entity: parentEntity, record: parent }, principal)
	}
	return false
}

/**
 * Every ancestor named in the path must exist, be live, and belong to the caller — and its own
 * ancestors must be the ones the path names. Without this, a caller could list or write rows of
 * another tenant's table by placing that table's id under their own project.
 */
export async function assertParents(state: ReferenceState, call: EntityCall): Promise<void> {
	const { entity, scope } = call
	for (const param of entity.parents) {
		const parentEntity = parentOf(state, param)
		if (parentEntity === undefined) continue
		const id = scope[param] ?? ""
		const parent = await state.store.byId(parentEntity, id)
		/* Under the defect a parent only has to exist: whose it is, and whose path names it, go
		 * unchecked — another tenant's parent id under the caller's own root is let through. */
		if (parent !== null && state.defects.has("FOREIGN_PARENT_ACCEPTED")) continue
		if (parent === null || !(await liveAndOwned(state, { entity: parentEntity, record: parent }, call))) {
			throw notFound(parentEntity, id)
		}
	}
}

/* A parent the call's path may name: linked to the path's own ancestors, live, and the caller's. */
async function liveAndOwned(state: ReferenceState, parent: EntityRecord, call: EntityCall): Promise<boolean> {
	const { entity, record } = parent
	const { scope } = call
	const linked = entity.parents.every(
		(ancestor) => !entity.fields.some((f) => f.name === ancestor) || record[ancestor] === scope[ancestor],
	)
	return linked && !tombstoned(entity, record) && ownedByTenant(state, parent, call.principal)
}

/**
 * A record is served under the path that names its own parents, and no other — all the way up: a
 * row's table must itself sit under the project the path names.
 */
export async function underPath(
	state: ReferenceState,
	{ entity, record }: EntityRecord,
	scope: Scope,
): Promise<boolean> {
	const stored = (param: string): boolean => entity.fields.some((f) => f.name === param)
	if (entity.parents.some((param) => stored(param) && scope[param] !== undefined && record[param] !== scope[param])) {
		return false
	}
	const parentParam = entity.parents.toReversed().find((param) => parentOf(state, param) !== undefined)
	if (parentParam === undefined || !stored(parentParam)) return true
	const parentEntity = parentOf(state, parentParam) as EntityDef
	const parent = await state.store.byId(parentEntity, record[parentParam] as string)
	return parent !== null && underPath(state, { entity: parentEntity, record: parent }, scope)
}

/* The resource a grant names: the entity's name and the record's id. */
type Granted = Pick<Grant, "entity" | "resourceId">

function canReadViaGrant(state: ReferenceState, { entity, resourceId }: Granted, principal: Principal): boolean {
	if (state.defects.has("INVITE_NEVER_GRANTS")) return false
	return [...state.grants.values()].some(
		(grant) =>
			grant.entity === entity &&
			grant.resourceId === resourceId &&
			grant.granteeKey === principal.key &&
			grant.accepted,
	)
}

/** The record a caller may read or write under this path, or the refusal a correct backend gives. */
export async function findItem(
	state: ReferenceState,
	call: ItemCall,
	purpose: "read" | "write" = "read",
): Promise<Row> {
	const { entity, itemId: id, principal, scope } = call
	const { defects } = state
	const record = await state.store.byId(entity, id)
	if (record === null || hiddenFromCreator(defects, entity, record)) throw notFound(entity, id)
	/* Writes looked up by id alone: reads stay scoped, so only a write probe can tell. */
	if (purpose === "write" && defects.has("CROSS_TENANT_WRITE")) return record
	/* A record named under somebody else's parents is not this caller's to read, whoever owns it. */
	const held = { entity, record }
	const inPath = await underPath(state, held, scope)
	const owned = inPath && (await ownedByTenant(state, held, principal))
	const granted = inPath && canReadViaGrant(state, { entity: entity.name, resourceId: String(id) }, principal)
	/* The leak is a lookup by id alone: no tenant check, and no check of the path either. */
	if (!defects.has("CROSS_TENANT_READ") && !owned && !granted) {
		/* Correct is 404: the same answer an id that never existed would get. Answering 403 here is
		 * the defect — the denial is right, but the *status* confirms the record is real, which is
		 * all an attacker enumerating identifiers needs. */
		throw defects.has("EXISTENCE_LEAK_VIA_STATUS")
			? new HttpError(403, "forbidden", `${entity.name} ${id} belongs to another tenant`)
			: notFound(entity, id)
	}
	if (tombstoned(entity, record)) throw notFound(entity, id, "has been deleted")
	return record
}
