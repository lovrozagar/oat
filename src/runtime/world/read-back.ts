/**
 * The record a create made, when its answer is not that record.
 *
 * A create may answer an acknowledgement, `{ id, message }`, or nothing but a `Location`. Taking
 * that for the record seeds the cohort with the acknowledgement's own fields: every check that
 * reads a field off a seeded record then works from what the server never said it stored. Such an
 * answer is read back through the entity's item read, by the id it gave, and the cohort holds what
 * the read returns. With nothing to read it back by, the record is what oat sent under that id,
 * marked unverified, and checks that would judge stored fields against it stand down.
 */

import type { Client } from "../../client/client.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { itemSchemaOf } from "../checks/payloads/item-schema.ts"
import type { CreatedId } from "../created-id.ts"
import { fillPath } from "../fill-path.ts"
import { readRoute } from "./confirm.ts"
import { idOf, isPlainRecord, type Record_, recordOf } from "./records.ts"
import { requestSchemaOf } from "./schema.ts"
import type { JsonSchema } from "../../spec/types.ts"

/** What a record must name: the item schema's required fields, and every field the create sent. */
export interface ExpectedFields {
	required: readonly string[]
	submitted: readonly string[]
}

/** The record a create made, and whether anything the server answered stands behind its fields. */
export interface CreatedRecord {
	record: Record_
	/** The answer named no id at all, and the client's own was confirmed by a read. */
	acknowledged: boolean
	/** The fields are the body oat sent under the id the answer gave: no read showed them stored. */
	unverified?: true
}

/**
 * Whether an answer is the record the create made: it names every field the item schema requires
 * and every field the create sent. Names, not values — a server may normalize what it stores.
 */
export function answersRecord(answer: Record_, expected: ExpectedFields): boolean {
	return [...expected.required, ...expected.submitted].every((name) => Object.hasOwn(answer, name))
}

/* A request property the server takes and never returns: a password, a secret. */
function writeOnly(schema: JsonSchema | null, name: string): boolean {
	const property = (schema?.properties as Record<string, JsonSchema> | undefined)?.[name]
	return property?.writeOnly === true
}

/** The fields the create's answer must name to be the record (`answersRecord`). */
export function expectedFields(model: SpecModel, createOp: OperationModel, sent: unknown): ExpectedFields {
	const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
	const opOf = (operationId: string | undefined): OperationModel | undefined =>
		operationId === undefined ? undefined : model.byOperationId.get(operationId)
	const item = itemSchemaOf({ listOp: opOf(entity?.list), model, readOp: opOf(entity?.read) })
	const request = requestSchemaOf(createOp, model)
	const submitted = isPlainRecord(sent)
		? Object.entries(sent)
				.filter(([name, value]) => value !== undefined && !writeOnly(request, name))
				.map(([name]) => name)
		: []
	return { required: (item?.required ?? []) as string[], submitted }
}

/** The created record as the item read shows it under `id`, or what was sent, unverified. */
export async function readBackCreated(input: {
	client: Pick<Client, "get">
	model: SpecModel
	createOp: OperationModel
	id: CreatedId
	sent: unknown
	scope: Record<string, string>
	/** The principal that created it, which reads it back: `as: { principal }`. */
	principal: string
	readable?: (op: OperationModel) => boolean
}): Promise<CreatedRecord> {
	const { createOp, id, model } = input
	const identity = (createOp.entity === null ? undefined : model.entities.get(createOp.entity))?.identity ?? "id"
	const unverified: CreatedRecord = {
		acknowledged: false,
		record: { ...(isPlainRecord(input.sent) ? input.sent : {}), [identity]: id.value },
		unverified: true,
	}
	const route =
		createOp.entity === null
			? null
			: readRoute({
					entity: createOp.entity,
					model,
					...(input.readable === undefined ? {} : { readable: input.readable }),
				})
	if (route === null) return unverified
	let path: string
	try {
		path = fillPath(route.readOp.path, { ...input.scope, [route.param]: id.id })
	} catch {
		return unverified
	}
	const read = await input.client.get(path, {
		as: { principal: input.principal },
		operationId: route.readOp.operationId,
	})
	const record = read.status < 200 || read.status >= 300 ? undefined : recordOf(route.readOp, read.responseBody)
	const readId = idOf(record, identity)
	if (record === undefined || (readId !== undefined && readId !== id.id)) return unverified
	return { acknowledged: false, record: readId === undefined ? { ...record, [identity]: id.value } : record }
}
