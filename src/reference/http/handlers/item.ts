/** One record: read, updated in place or replaced, and deleted outright or softly. */

import { ROW } from "../../model/row.ts"
import type { Row } from "../../store-api.ts"
import { assertWrite, findItem } from "../access.ts"
import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { assertPrivileged, keepPrivileged } from "../privileged.ts"
import { answerRead, answerWritten, hiddenFromCreator, present, replacementDefaults, withDefaults } from "../records.ts"
import type { ReferenceState } from "../state.ts"
import { assertUnique, readModifyWrite, refreshParentCount } from "../store-ops.ts"
import { validateBody } from "../validation.ts"
import { type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"
import type { ItemCall } from "./entity.ts"

export async function read(state: ReferenceState, call: ItemCall): Promise<ReferenceResponse> {
	/* Invert only the middle rank: viewer still reads, owner still reads, member does not. Denying
	 * the owner would collapse the rest of the suite. */
	if (state.defects.has("ROLE_MONOTONICITY_BROKEN") && call.principal.rank === 1) {
		throw new HttpError(403, "forbidden", "role cannot read this record")
	}
	const shown = present(state, call.entity, await findItem(state, call))
	if (state.defects.has("READ_DROPS_FIELD") && call.entity.name === state.table.name) delete shown.description
	return respond(200, answerRead(state, call.entity, shown))
}

export async function update(
	state: ReferenceState,
	request: ReferenceRequest,
	call: ItemCall,
): Promise<ReferenceResponse> {
	const { entity, principal, itemId } = call
	const { defects } = state
	assertWrite(state, principal, "update")
	requireJson(request, defects)
	const existing = await findItem(state, call, "write")
	const replace = request.method === "PUT"
	const lenient = defects.has("WRITE_BODY_NOT_VALIDATED") && [state.table.name, ROW.name].includes(entity.name)
	const mode = replace ? "replace" : "update"
	const patch = validateBody(await readJson(request), { defects, entity, lenient, mode })
	assertPrivileged(state, call, patch)
	const changes = keepPrivileged(state, call, changesOf(state, call, { patch, replace }))
	await assertUnique(state, { entity, record: { ...existing, ...changes } }, String(itemId))
	const updated = defects.has("CONCURRENT_WRITE_LOST")
		? await readModifyWrite(state, { entity, id: itemId }, changes)
		: await state.store.update(entity, itemId, changes)
	return respond(
		defects.has("RESPONSE_STATUS_UNDECLARED") ? 201 : 200,
		answerWritten(state, { entity, record: present(state, entity, updated ?? { ...existing, ...changes }) }, "updated"),
	)
}

/*
 * Write only the fields the caller named.
 *
 * Merging the existing record and writing every column back is the `save(entity)` pattern, and it
 * loses concurrent writes to *other* fields: whichever request commits second reinstates the values
 * it read before the first had committed. PUT is a replacement by contract: what the body leaves
 * out is reset, not kept.
 */
function changesOf(state: ReferenceState, call: ItemCall, sent: { patch: Row; replace: boolean }): Row {
	const { entity, principal } = call
	const { defects } = state
	const changes: Row = defects.has("PATCH_REPLACES")
		? {
				...withDefaults(state, { entity, scope: { ...call.scope, project_id: principal.projectId } }, {}),
				...sent.patch,
			}
		: sent.replace
			? { ...replacementDefaults(entity), ...sent.patch }
			: { ...sent.patch }
	changes.updated_at = state.ids.stamp()
	delete changes[entity.identity]
	/* Under `tableKey: "slug"` the slug is the identity a client knows: no write changes it. */
	if (state.shape.tableKey === "slug" && entity.name === state.table.name) delete changes.slug
	delete changes.created_at
	if (!defects.has("IMMUTABLE_WRITABLE")) for (const parent of entity.parents) delete changes[parent]
	return changes
}

export async function remove(state: ReferenceState, call: ItemCall): Promise<ReferenceResponse> {
	const { entity, principal, itemId } = call
	const { defects } = state
	assertWrite(state, principal, "delete")
	const existing = await state.store.byId(entity, itemId)
	if (existing === null) {
		if (defects.has("DELETE_MISSING_OK")) return respond(200, { [entity.identity]: itemId })
		throw new HttpError(404, "not_found", `${entity.name} ${itemId} does not exist`)
	}
	/* Answers that it removed a row it keeps. */
	if (hiddenFromCreator(defects, entity, existing)) {
		return respond(200, answerWritten(state, { entity, record: present(state, entity, existing) }, "deleted"))
	}
	const record = await findItem(state, call, "write")
	if (entity.softDeleteField !== undefined) {
		const now = state.ids.stamp()
		const updated = await state.store.update(entity, itemId, { [entity.softDeleteField]: now, updated_at: now })
		return respond(200, answerWritten(state, { entity, record: present(state, entity, updated ?? record) }, "deleted"))
	}
	if (!defects.has("DELETE_KEEPS_ROW")) {
		await state.store.remove(entity, itemId)
		await refreshParentCount(state, entity, call.scope)
	}
	return respond(200, answerWritten(state, { entity, record: present(state, entity, record) }, "deleted"))
}
