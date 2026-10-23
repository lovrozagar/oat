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
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { messageOf } from "../../errors/message.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { itemSchemaOf } from "../checks/payloads/item-schema.ts"
import type { CreatedId } from "../created-id.ts"
import type { Exchange } from "../exchange.ts"
import { FencedError } from "../fence.ts"
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
	/**
	 * The fields are the body oat sent under the id the answer gave, and why no read showed them
	 * stored: `no item read`, `read back answered 404`.
	 */
	unverified?: string
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

/** What the create answered, short of the record: only the fields the record's own schema has. */
function answeredOf(input: { answered?: unknown }): Record<string, unknown> {
	return isPlainRecord(input.answered) ? input.answered : {}
}

/**
 * The fields of a create's answer the entity's record declares: an acknowledgement's `message` is
 * no field of the record, and is never seeded as one. Nothing, when the record declares none.
 */
export function declaredFields(
	model: SpecModel,
	createOp: OperationModel,
	answer: Record<string, unknown>,
): Record<string, unknown> {
	const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
	const opOf = (operationId: string | undefined): OperationModel | undefined =>
		operationId === undefined ? undefined : model.byOperationId.get(operationId)
	const item = itemSchemaOf({ listOp: opOf(entity?.list), model, readOp: opOf(entity?.read) })
	const properties = (item?.properties ?? {}) as Record<string, unknown>
	return Object.fromEntries(Object.entries(answer).filter(([name]) => Object.hasOwn(properties, name)))
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

/**
 * The created record as the item read shows it under `id`, over what the create answered; or,
 * unverified, what the create answered over what was sent: the answer is the server's, the body only
 * what oat asked for.
 */
export async function readBackCreated(input: {
	client: Pick<Client, "get">
	model: SpecModel
	createOp: OperationModel
	id: CreatedId
	sent: unknown
	/** What the create answered, short of the record: kept in an unverified one. */
	answered?: unknown
	scope: Record<string, string>
	/** The principal that created it, which reads it back: `as: { principal }`. */
	principal: string
	readable?: (op: OperationModel) => boolean
}): Promise<CreatedRecord> {
	const { createOp, id, model } = input
	const identity = (createOp.entity === null ? undefined : model.entities.get(createOp.entity))?.identity ?? "id"
	const unverified = (cause: string): CreatedRecord => ({
		acknowledged: false,
		record: {
			...(isPlainRecord(input.sent) ? input.sent : {}),
			...answeredOf(input),
			[identity]: id.value,
		},
		unverified: cause,
	})
	const route =
		createOp.entity === null
			? null
			: readRoute({
					entity: createOp.entity,
					model,
					...(input.readable === undefined ? {} : { readable: input.readable }),
				})
	if (route === null) return unverified("no item read")
	let path: string
	try {
		path = fillPath(route.readOp.path, { ...input.scope, [route.param]: id.id })
	} catch (error) {
		return unverified(`the item read could not be addressed: ${messageOf(error)}`)
	}
	const read = await sendable(() =>
		input.client.get(path, { as: { principal: input.principal }, operationId: route.readOp.operationId }),
	)
	if (typeof read === "string") return unverified(`read back could not be sent: ${read}`)
	if (read.status < 200 || read.status >= 300) return unverified(`read back answered ${read.status}`)
	const record = recordOf(route.readOp, read.responseBody)
	if (record === undefined) return unverified(`read back answered ${read.status} without the record`)
	const readId = idOf(record, identity)
	if (readId !== undefined && readId !== id.id)
		return unverified(`read back answered ${read.status} with another record`)
	/* The read shows what is stored; a field it leaves out keeps what the create answered. */
	return { acknowledged: false, record: { ...answeredOf(input), ...record, [identity]: readId ?? id.value } }
}

/*
 * The read, or why the creator could not send it: a credential that cannot meet its security, or
 * the fence refusing it. Anything else, a network error among them, ends the seed as it would.
 */
async function sendable(send: () => Promise<Exchange>): Promise<Exchange | string> {
	try {
		return await send()
	} catch (error) {
		if (error instanceof UnsatisfiedSecurity || error instanceof FencedError) return error.message
		throw error
	}
}
