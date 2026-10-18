import type { OperationModel } from "../../spec/graph/types.ts"
import { listExisting } from "./list-existing.ts"
import { isScalarId, type Record_ } from "./records.ts"
import type { Scope, Seeding } from "./types.ts"

/** First listed record with a usable identity, or null — never synthesises a row. */
export async function adoptExisting(createOp: OperationModel, seeding: Seeding, scope: Scope): Promise<Record_ | null> {
	const { model, client, options } = seeding
	const name = createOp.entity
	if (name === null) return null
	const entity = model.entities.get(name)
	if (entity?.list === undefined) return null
	/* A list id names an operation of the model. */
	const listOp = model.byOperationId.get(entity.list) as OperationModel
	const records = await listExisting(
		{ listOp, model, values: { ...options.roots, ...scope.values } },
		client,
		options.authHeaders,
	)
	const identity = entity.identity ?? "id"
	return records.find((record) => isScalarId(record[identity])) ?? null
}
