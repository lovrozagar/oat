import type { RequestOptions } from "../../../../../client/types.ts"
import type { FindingCollector } from "../../../../finding.ts"
import type { SpecModel } from "../../../../../spec/graph/types.ts"
import { type Answer, contextFor, type Sent } from "../../../__fixtures__/harness.ts"
import type { Actor, CheckContext, WriteContext } from "../../../core/context.ts"

/*
 * A context for the notes entity as a run builds it: the entity's own operations, the owner in
 * org o1 with one seeded note, and a peer in org o2. Fields override any of it.
 */

/** A principal: `id` is who the backend sees, and the rest is what the run binds for it. */
export function actor(id: string, fields: Pick<Actor, "rank"> & Partial<Actor>): Actor {
	return { id, inviteAs: undefined, scope: {}, tenant: undefined, ...fields }
}

export const OWNER = actor("owner", { rank: 0, scope: { org_id: "o1" }, tenant: "o1" })
export const OTHER = actor("other", { rank: 0, scope: { org_id: "o2" }, tenant: "o2" })

/** Who sent a request: the principal its `as` names, or `undefined` for one sent as nobody. */
export function caller(sent: Pick<Sent, "options">): string | undefined {
	const { as } = sent.options
	return "principal" in as ? as.principal : undefined
}

/**
 * A backend that knows who asks, the way a real one knows by the credential the client placed:
 * `who` is the principal the request was sent as, `""` for one sent as nobody.
 */
export type Backend = (method: string, path: string, request: Asked) => Answer | undefined

/** A request as a backend reads it: what it carries, and who sent it. */
export type Asked = Omit<RequestOptions, "as"> & { who: string }

/**
 * A check staged over `listOperation` and answered by `backend`. The fake client records each
 * request before it is answered, so the latest one recorded is the one being answered.
 */
export function stagedFor(
	model: SpecModel,
	listOperation: string,
	{ backend, fields }: { backend: Backend; fields: Partial<CheckContext> },
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	const recorded: { sent: Sent[] } = { sent: [] }
	const respond = (method: string, path: string, options: Omit<RequestOptions, "as">) => {
		const last = recorded.sent.at(-1)
		return backend(method, path, { ...options, who: last === undefined ? "" : (caller(last) ?? "") })
	}
	const staged = contextFor(model, listOperation, { fields, respond })
	recorded.sent = staged.sent
	return staged
}

/** Context fields to override; `peer: undefined` leaves the peer out. */
export type NotesFields = Omit<Partial<CheckContext>, "peer"> & { peer?: Actor | undefined }

export function notesContext(
	model: SpecModel,
	backend: Backend,
	fields: NotesFields = {},
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	const { peer, ...rest } = { peer: OTHER, ...fields }
	const entity = model.entities.get("note")
	const opOf = (id: string | undefined) => (id === undefined ? undefined : model.byOperationId.get(id))
	const listOp = model.byOperationId.get("listNotes")
	return stagedFor(model, "listNotes", {
		backend,
		fields: {
			actor: OWNER,
			actors: [OWNER, OTHER],
			collectionKey: listOp?.collection?.key ?? null,
			createOp: opOf(entity?.create),
			deleteOp: opOf(entity?.delete),
			peerScope: OTHER.scope,
			query: listOp?.query ?? null,
			readOp: opOf(entity?.read),
			records: [{ id: "n1", title: "first" }],
			scope: OWNER.scope,
			updateOp: opOf(entity?.update),
			...rest,
			...(peer === undefined ? {} : { peer }),
		},
	})
}
