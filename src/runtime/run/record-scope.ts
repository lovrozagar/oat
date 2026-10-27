import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"

/*
 * A minted credential is a record, and the operations that address it (its revoke, its entity's
 * read and delete) take its identity as their last path parameter, whatever they call it: an
 * `{api_key_id}` the mint answer names `id`. The record's scope is what the mint answered and what
 * the principal binds; the last parameter, when nothing there is named like it, is the record's
 * identity, the field the model knows for the operation's entity, else `id`.
 */

/** `scope` with `op`'s last path parameter bound to the record's identity when nothing named like it is. */
export function recordScope(
	model: Pick<SpecModel, "entities">,
	op: Pick<OperationModel, "entity" | "pathParams">,
	scope: Readonly<Record<string, string>>,
): Record<string, string> {
	const last = op.pathParams.at(-1)
	if (last === undefined || scope[last] !== undefined) return { ...scope }
	const field = (op.entity === null ? undefined : model.entities.get(op.entity)?.identity) ?? "id"
	const id = scope[field] ?? scope["id"]
	return id === undefined ? { ...scope } : { ...scope, [last]: id }
}
