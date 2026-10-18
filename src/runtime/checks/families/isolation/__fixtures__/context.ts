import type { FindingCollector } from "../../../../finding.ts"
import type { SpecModel } from "../../../../../spec/graph/types.ts"
import { contextFor, type Responder, type Sent } from "../../../__fixtures__/harness.ts"
import type { Actor, CheckContext, WriteContext } from "../../../core/context.ts"

/*
 * A context for the notes entity as a run builds it: the entity's own operations, the owner in
 * org o1 with one seeded note, and a second principal in org o2. Fields override any of it.
 */

export const OWNER = { authorization: "owner" }
export const OTHER = { authorization: "other" }

export function notesContext(
	model: SpecModel,
	respond: Responder,
	fields: Partial<CheckContext> = {},
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	const entity = model.entities.get("note")
	const opOf = (id: string | undefined) => (id === undefined ? undefined : model.byOperationId.get(id))
	const listOp = model.byOperationId.get("listNotes")
	return contextFor(model, "listNotes", respond, {
		altAuth: () => OTHER,
		altScope: { org_id: "o2" },
		auth: () => OWNER,
		collectionKey: listOp?.collection?.key ?? null,
		createOp: opOf(entity?.create),
		deleteOp: opOf(entity?.delete),
		query: listOp?.query ?? null,
		readOp: opOf(entity?.read),
		records: [{ id: "n1", title: "first" }],
		scope: { org_id: "o1" },
		updateOp: opOf(entity?.update),
		...fields,
	})
}

/** A principal: `id` doubles as its credential, so a responder can tell who sent a request. */
export function actor(id: string, rank: number, roots: Record<string, string>, extra: Partial<Actor> = {}): Actor {
	return {
		headers: () => ({ authorization: id }),
		id,
		inviteAs: undefined,
		rank,
		role: undefined,
		roots,
		scope: roots,
		...extra,
	}
}

/** Who sent a request, by the credential `actor` and `notesContext` put on it. */
export function caller(options: { headers?: unknown }): string | undefined {
	const headers = options.headers as Record<string, string> | undefined
	return headers?.authorization
}
