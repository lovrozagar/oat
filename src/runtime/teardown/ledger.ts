/**
 * Teardown of everything a run created.
 *
 * A tester that leaves its fixtures behind is a tester nobody runs twice against anything real.
 * Records are unwound newest-first so children go before the parents they depend on, and every
 * failure is collected rather than thrown — a teardown that aborts halfway is worse than one that
 * reports exactly what it could not remove.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import { keyOf, recordKey } from "./routes.ts"
import type { Created, Disposable, Owner, TeardownReport, UnidentifiedCreate, UnwindOptions } from "./types.ts"
import { unwindQueue } from "./unwind.ts"

/** How the ledger is unwound: who else may remove a record, and the unwind's options. */
export interface LedgerUnwind {
	/* Principals allowed to remove a record its creator was refused, strongest first — the
	 * same tenant's owner removing what a member created. */
	fallbacks: (owner: Owner) => Owner[]
	options?: UnwindOptions
}

/**
 * Registry of what a run brought into existence, recorded the moment each record is created.
 *
 * Entries carry their creator. Removing a record with somebody else's credential is at best a
 * 403 and at worst a 404 that reads as success while the record sits on in the creator's tenant —
 * so the creator deletes first, and a 404 counts as removal only when the creator sees it.
 * Entities are recorded in creation order so the unwind can reverse it. A record oat adopted
 * rather than created must never be recorded here: it was not oat's to remove.
 */
export class Ledger {
	private readonly items: Disposable[] = []
	private readonly seen = new Set<string>()
	/* By exchange: one create is reported once, whichever path saw it. */
	private readonly unknown = new Map<number, UnidentifiedCreate>()
	/* Records an accepted write moved, by entity and id, with what moved them. */
	private readonly movedAway = new Map<string, string>()
	/* Records a principal read back — `entity, id, principal` — wherever the read came from. */
	private readonly sightings = new Set<string>()
	/* Every record ever ledgered, by entity and id, whoever created it. */
	private readonly held = new Set<string>()

	record({ entity, id, scope, inferred }: Created, owner: Owner): void {
		if (id === "" || id === "undefined") return
		/* By principal too: ids are often unique only within a tenant, and each tenant's is its own. */
		const key = recordKey(entity, id, owner.id)
		if (this.seen.has(key)) return
		this.seen.add(key)
		this.held.add(`${entity}\u0000${id}`)
		this.items.push({ entity, id, owner, scope: { ...scope }, ...(inferred === true ? { inferred } : {}) })
	}

	/** Whether any principal's record of `entity` with `id` was ever ledgered, removed since or not. */
	holds(entity: string, id: string): boolean {
		return this.held.has(`${entity}\u0000${id}`)
	}

	/** A create that answered 2xx without an id oat could read: nothing can remove its record. */
	unidentified(entity: string, operationId: string, exchange: Exchange): void {
		if (this.unknown.has(exchange.seq)) return
		this.unknown.set(exchange.seq, {
			entity,
			method: exchange.method,
			operationId,
			seq: exchange.seq,
			status: exchange.status,
			url: exchange.url,
		})
	}

	/**
	 * A write the backend accepted moved a ledgered record — changed a tenant or parent key, say —
	 * so its creator's 404 no longer shows it gone: it may sit on wherever the write put it.
	 */
	moved(entity: string, id: string, reason: string): void {
		this.movedAway.set(`${entity}\u0000${id}`, reason)
	}

	/**
	 * A principal read the record back: a read under its id, or a row of a listing. Only its
	 * creator's sighting counts toward showing it gone; a create's own answer is not one.
	 */
	sighted(entity: string, id: string, principal: string): void {
		this.sightings.add(recordKey(entity, id, principal))
	}

	private seenByCreator(item: Disposable): boolean {
		return this.sightings.has(keyOf(item))
	}

	/** Every create reported unidentified so far, in the order oat sent them. */
	get unidentifiedCreates(): UnidentifiedCreate[] {
		return [...this.unknown.values()].sort((a, b) => a.seq - b.seq)
	}

	/** Records waiting to be removed. */
	get size(): number {
		return this.items.length
	}

	/** Every record the run made, removed or not. */
	get recorded(): number {
		return this.seen.size
	}

	entries(): readonly Disposable[] {
		return this.items
	}

	unwind(model: SpecModel, client: Client, { fallbacks, options = {} }: LedgerUnwind): Promise<TeardownReport> {
		/* Takes what is ledgered now; a later unwind removes only what was recorded after this one. */
		const queue = this.items.splice(0).toReversed()
		return unwindQueue({
			client,
			fallbacks,
			ledger: {
				movedAway: (item) => this.movedAway.get(`${item.entity}\u0000${item.id}`),
				seenByCreator: (item) => this.seenByCreator(item),
				sighted: (entity, id, principal) => this.sighted(entity, id, principal),
			},
			model,
			options,
			queue,
		})
	}
}
