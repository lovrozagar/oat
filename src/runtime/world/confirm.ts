import type { Client } from "../../client/client.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { idOf, isPlainRecord, type Record_, recordOf } from "./records.ts"

export interface ConfirmInput {
	client: Pick<Client, "get">
	model: SpecModel
	entity: string
	identity: string
	sent: unknown
	/** The id to read under, when the answer suggested one; otherwise the identity oat sent. */
	id?: string
	scope: Record<string, string>
	/** The principal it reads as: `as: { principal }`. */
	principal: string
	ignore?: readonly string[]
	readable?: (op: OperationModel) => boolean
}

/** The entity's read and the path parameter that names the record, when oat may call it. */
export function readRoute(
	input: Pick<ConfirmInput, "entity" | "model" | "readable">,
): { readOp: OperationModel; param: string } | null {
	const readId = input.model.entities.get(input.entity)?.read
	const readOp = readId === undefined ? undefined : input.model.byOperationId.get(readId)
	const param = readOp?.pathParams.at(-1)
	if (readOp === undefined || param === undefined || input.readable?.(readOp) === false) return null
	return { param, readOp }
}

/** The scalar fields oat sent, which the read must show, leaving out the identity and `ignore`. */
function sentFields(sent: Record_, input: ConfirmInput): Array<[string, unknown]> {
	const ignored = new Set([input.identity, ...(input.ignore ?? [])])
	return Object.entries(sent).filter(
		([key, value]) =>
			!ignored.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
	)
}

/**
 * Reads back a record an acknowledgment-only create made under a client-chosen identity.
 *
 * An id oat only sent proves nothing: a server may ignore it and store the record under one of its
 * own, and on an integer-id API the id oat sent can belong to somebody else's row. The submitted
 * id counts only when the entity's read, under that id, answers with that id and with every scalar
 * field oat sent (`ignore` names fields the caller expects to differ). Anything less — no read, a
 * read oat may not call, a refusal, another record — is `null`, and the record stays untracked.
 */
export async function confirmSubmitted(input: ConfirmInput): Promise<Record_ | null> {
	const { identity, sent } = input
	if (!isPlainRecord(sent)) return null
	const id = input.id ?? idOf(sent, identity)
	if (id === undefined) return null
	const fields = sentFields(sent, input)
	if (fields.length === 0) return null
	const route = readRoute(input)
	if (route === null) return null
	let path: string
	try {
		path = fillPath(route.readOp.path, { ...input.scope, [route.param]: id })
	} catch {
		return null
	}
	const read = await input.client.get(path, {
		as: { principal: input.principal },
		operationId: route.readOp.operationId,
	})
	const record = read.status < 200 || read.status >= 300 ? undefined : recordOf(route.readOp, read.responseBody)
	if (record === undefined) return null
	if (idOf(record, identity) !== id) return null
	return fields.every(([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value)) ? record : null
}
