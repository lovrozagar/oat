/**
 * Removing one record: its delete sent by its creator first, then by each principal allowed to
 * remove what the creator was refused. Gone is the goal, not a successful call.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { Exchange } from "../exchange.ts"
import { fillPath } from "../fill-path.ts"
import { deleteOperationFor } from "./routes.ts"
import type { Disposable, LedgerView, Owner, RecordState, TeardownReport, UnwindOptions } from "./types.ts"

/** An unwind in progress: what it removes with, and what it has learned so far. */
export interface Unwind {
	model: SpecModel
	client: Client
	fallbacks: (owner: Owner) => Owner[]
	ledger: LedgerView
	onItem: UnwindOptions["onItem"]
	report: TeardownReport
	records: ReadonlyMap<Disposable, RecordState>
	/** The delete path each record was sent to. */
	paths: Map<Disposable, string>
	unsupported: Set<string>
	deletedEarlier: (path: string) => boolean
	done: number
	total: number
}

/** A record still in place, as the report lists it. */
export function leftover(item: Disposable, reason: string): TeardownReport["failed"][number] {
	return { entity: item.entity, id: item.id, principal: item.owner.id, reason }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Whether an answer shows the record gone. Only the creator's 404 says so — anyone else's may just
 * mean they cannot see it — and not once a write moved the record away.
 */
function shownGone(exchange: Exchange, byCreator: boolean, moved: string | undefined): boolean {
	return (
		exchange.status < 300 || (byCreator && moved === undefined && (exchange.status === 404 || exchange.status === 410))
	)
}

/*
 * A record whose entity has no delete. A declared create's entity is listed once as unsupported; an
 * inferred record is named, since no create in the document warns its reader that the record exists.
 */
function undeletable(state: Unwind, item: Disposable): void {
	if (item.inferred === true) {
		const reason = `inferred from an answer that named a new ${item.entity}_id; the document declares no delete for ${item.entity}`
		state.report.failed.push(leftover(item, reason))
	} else state.unsupported.add(item.entity)
	state.done += 1
}

export async function removeOne(state: Unwind, item: Disposable): Promise<void> {
	const { report } = state
	const deleteOp = deleteOperationFor(item.entity, state.model)
	if (deleteOp === null) {
		undeletable(state, item)
		return
	}

	const param = deleteOp.pathParams.at(-1)
	const scope = param === undefined ? item.scope : { ...item.scope, [param]: item.id }

	let path: string
	try {
		path = fillPath(deleteOp.path, scope)
	} catch (error) {
		report.failed.push(leftover(item, messageOf(error)))
		state.done += 1
		return
	}
	state.paths.set(item, path)

	const moved = state.ledger.movedAway(item)
	try {
		const attempts: string[] = []
		let removed = false
		for (const [index, deleter] of [item.owner, ...state.fallbacks(item.owner)].entries()) {
			/* An x-cleanup route may remove with another method than DELETE: its own is sent. */
			const exchange = await deleteAs(state, { method: deleteOp.method, path }, deleter.id)
			if (typeof exchange === "string") {
				attempts.push(`${deleter.id}: ${exchange}`)
				continue
			}
			attempts.push(`${deleter.id}: ${exchange.status}`)
			if (shownGone(exchange, index === 0, moved)) {
				removed = true
				break
			}
			/* Only a denial is worth retrying with a stronger credential. */
			if (exchange.status !== 401 && exchange.status !== 403) break
		}
		/* A delete earlier in the run already removed it: a tenant the creator then left may refuse
		 * every later request, its own delete included. The call above still goes first, so a
		 * record restored since is removed rather than assumed gone. */
		if (!removed && state.deletedEarlier(path)) removed = true
		settle(
			state,
			item,
			removed ? null : `${moved === undefined ? "" : `${moved}; `}DELETE ${path} returned ${attempts.join(", ")}`,
		)
	} catch (error) {
		report.failed.push(leftover(item, messageOf(error)))
	}
	state.done += 1
	state.onItem?.(state.done, state.total, item)
}

/*
 * One deleter's request: its exchange, or why it could not be sent, a credential the deleter cannot
 * hold (BLOCKED by a failed login or renewal) say, so the next deleter is tried as after a denial.
 */
async function deleteAs(
	state: Unwind,
	route: { method: string; path: string },
	principal: string,
): Promise<Exchange | string> {
	try {
		return await state.client.request(route.method, route.path, { as: { principal } })
	} catch (error) {
		if (!(error instanceof UnsatisfiedSecurity)) throw error
		return `not sent (${error.reason})`
	}
}

/** Counts the record removed, or a leftover for `reason`. */
function settle(state: Unwind, item: Disposable, reason: string | null): void {
	if (reason !== null) {
		state.report.failed.push(leftover(item, reason))
		return
	}
	state.report.removed += 1
	/* Every record the unwind was given has its line. */
	const record = state.records.get(item) as RecordState
	record.removed = true
}
