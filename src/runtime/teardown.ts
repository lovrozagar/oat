/**
 * Teardown of everything a run created.
 *
 * A tester that leaves its fixtures behind is a tester nobody runs twice against anything real.
 * Records are unwound newest-first so children go before the parents they depend on, and every
 * failure is collected rather than thrown — a teardown that aborts halfway is worse than one that
 * reports exactly what it could not remove.
 */

import { largestPageQuery, type OperationModel, type SpecModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import { parseRouteRef } from "../spec/load.ts"
import { FencedError } from "./fence.ts"
import { isNetworkError } from "./network.ts"
import { fillPath, recordsFromList } from "./world.ts"
import type { ProvenId } from "./proven-id.ts"

/** The principal a record belongs to, as far as removing it goes. */
export interface Owner {
	id: string
	headers: () => Record<string, string>
}

export interface Disposable {
	entity: string
	id: string
	/** Path parameters in scope when the record was created. */
	scope: Record<string, string>
	/** Who created it. Only the creator's view of the record decides whether it is gone. */
	owner: Owner
}

/** A create that answered 2xx without an id oat could read: what it made may remain. */
export interface UnidentifiedCreate {
	entity: string
	operationId: string
	method: string
	url: string
	status: number
	/** The exchange's sequence number in the run's transcript. */
	seq: number
}

export interface TeardownReport {
	removed: number
	failed: Array<{ entity: string; id: string; reason: string }>
	unsupported: string[]
	/** Every record the unwind was given, in creation order, and whether it is gone now. */
	records: Array<{ entity: string; id: string; removed: boolean }>
	/** Creates whose record oat could not identify, so could not remove. Each fails the run. */
	unidentified: UnidentifiedCreate[]
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

	record(entity: string, id: ProvenId, scope: Record<string, string>, owner: Owner): void {
		if (id === "" || id === "undefined") return
		const key = `${entity}\u0000${id}`
		if (this.seen.has(key)) return
		this.seen.add(key)
		this.items.push({ entity, id, owner, scope: { ...scope } })
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

	async unwind(
		model: SpecModel,
		client: Client,
		/* Principals allowed to remove a record its creator was refused, strongest first — the
		 * same tenant's owner removing what a member created. */
		fallbacks: (owner: Owner) => Owner[],
		onItem?: (done: number, total: number, item: Disposable) => void,
		/* Read each list again afterwards, so a 2xx delete that kept its record is not counted gone. */
		verify = true,
	): Promise<TeardownReport> {
		const report: TeardownReport = { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] }
		const unsupported = new Set<string>()

		/*
		 * Deepest first, one level at a time, and every record within a level at once. A record's
		 * depth is how many path parameters its delete route takes: a child's route carries its
		 * parent's parameters and its own, so a level never holds a record and its parent.
		 * Newest first within a level keeps the order the creation sequence implies.
		 */
		/* Takes what is ledgered now; a later unwind removes only what was recorded after this one. */
		const queue = this.items.splice(0).reverse()
		const records = new Map(queue.map((item) => [item, { entity: item.entity, id: item.id, removed: false }]))
		const earlierDeletes = new Set(
			client.transcript
				.filter((exchange) => exchange.method === "DELETE" && exchange.status >= 200 && exchange.status < 300)
				.map((exchange) => new URL(exchange.url).pathname),
		)
		const deletedEarlier = (path: string): boolean => {
			const pathname = path.split("?")[0] ?? path
			return [...earlierDeletes].some((done) => done.endsWith(pathname))
		}
		const depthOf = (item: Disposable): number => deleteOperationFor(item.entity, model)?.pathParams.length ?? 0
		const levels = [...new Set(queue.map(depthOf))].sort((a, b) => b - a)
		let done = 0
		const remove = async (item: Disposable): Promise<void> => {
			const deleteOp = deleteOperationFor(item.entity, model)
			if (deleteOp === null) {
				unsupported.add(item.entity)
				done += 1
				return
			}

			const param = deleteOp.pathParams.at(-1)
			const scope = param === undefined ? item.scope : { ...item.scope, [param]: item.id }

			let path: string
			try {
				path = fillPath(deleteOp.path, scope)
			} catch (error) {
				report.failed.push({
					entity: item.entity,
					id: item.id,
					reason: error instanceof Error ? error.message : String(error),
				})
				done += 1
				return
			}

			try {
				const attempts: string[] = []
				let removed = false
				for (const [index, deleter] of [item.owner, ...fallbacks(item.owner)].entries()) {
					const exchange = await client.request("DELETE", path, { headers: deleter.headers })
					attempts.push(`${deleter.id}: ${exchange.status}`)
					/* Gone is the goal, not a successful call — but only the creator's 404 says the
					 * record is gone. Anyone else's may just mean they cannot see it. */
					if (exchange.status < 300 || (index === 0 && (exchange.status === 404 || exchange.status === 410))) {
						removed = true
						break
					}
					/* Only a denial is worth retrying with a stronger credential. */
					if (exchange.status !== 401 && exchange.status !== 403) break
				}
				/* A delete earlier in the run already removed it: a tenant the creator then left
				 * may refuse every later request, its own delete included. The call above still
				 * goes first, so a record restored since is removed rather than assumed gone. */
				if (!removed && deletedEarlier(path)) removed = true
				if (removed) {
					report.removed += 1
					const record = records.get(item)
					if (record !== undefined) record.removed = true
				} else {
					report.failed.push({
						entity: item.entity,
						id: item.id,
						reason: `DELETE ${path} returned ${attempts.join(", ")}`,
					})
				}
			} catch (error) {
				report.failed.push({
					entity: item.entity,
					id: item.id,
					reason: error instanceof Error ? error.message : String(error),
				})
			}
			done += 1
			onItem?.(done, queue.length, item)
		}
		for (const level of levels) {
			await Promise.all(queue.filter((item) => depthOf(item) === level).map(remove))
		}

		if (verify) await verifyGone(model, client, queue, records, report)
		report.unsupported = [...unsupported]
		report.records = [...records.values()].toReversed()
		return report
	}
}

export const STILL_LISTED = "delete answered 2xx but the record is still listed"

/**
 * One read of each list a removed record lived in, with its creator's credential: a record still
 * listed is a leftover, whatever its delete answered. A read that cannot be sent — fenced, or the
 * network gone — verifies nothing and claims nothing. A record past the largest page is not seen.
 */
async function verifyGone(
	model: SpecModel,
	client: Client,
	queue: readonly Disposable[],
	records: ReadonlyMap<Disposable, { entity: string; id: string; removed: boolean }>,
	report: TeardownReport,
): Promise<void> {
	const groups = new Map<
		string,
		{ identity: string; listOp: OperationModel; owner: Owner; path: string; items: Disposable[] }
	>()
	for (const item of queue) {
		if (records.get(item)?.removed !== true) continue
		const entity = model.entities.get(item.entity)
		const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
		if (entity === undefined || listOp === undefined || entity.identity === null) continue
		let path: string
		try {
			path = fillPath(listOp.path, item.scope)
		} catch {
			continue
		}
		const key = `${item.entity}\u0000${path}\u0000${item.owner.id}`
		const group = groups.get(key) ?? { identity: entity.identity, items: [], listOp, owner: item.owner, path }
		group.items.push(item)
		groups.set(key, group)
	}
	for (const group of groups.values()) {
		let exchange: Exchange
		try {
			exchange = await client.get(group.path, {
				headers: group.owner.headers(),
				operationId: group.listOp.operationId,
				query: largestPageQuery(model, group.listOp),
			})
		} catch (error) {
			if (error instanceof FencedError || isNetworkError(error)) continue
			throw error
		}
		if (exchange.status >= 300) continue
		const listed = new Set(
			recordsFromList(exchange.responseBody, group.listOp.collection?.key ?? null).map((row) =>
				String(row[group.identity]),
			),
		)
		for (const item of group.items) {
			const record = records.get(item)
			if (record === undefined || !listed.has(item.id)) continue
			record.removed = false
			report.removed -= 1
			report.failed.push({ entity: item.entity, id: item.id, reason: STILL_LISTED })
		}
	}
}

/**
 * The operation that removes an instance: the entity's own delete, or an explicit `x-cleanup`
 * route for entities whose removal lives somewhere the graph does not connect.
 */
function deleteOperationFor(entityName: string, model: SpecModel): OperationModel | null {
	const entity = model.entities.get(entityName)
	if (entity?.delete !== undefined) {
		const op = model.byOperationId.get(entity.delete)
		if (op !== undefined) return op
	}

	for (const op of model.operations) {
		if (op.entity !== entityName || op.cleanup === null) continue
		const parsed = parseRouteRef(op.cleanup)
		if (parsed === null) continue
		const target = model.byRoute.get(`${parsed.method} ${parsed.path}`)
		if (target !== undefined) return target
	}
	return null
}

export function renderTeardown(report: TeardownReport, created: number): string[] {
	const lines = renderUnidentified(report.unidentified)
	if (created === 0) return lines

	if (report.failed.length === 0 && report.unsupported.length === 0) {
		lines.push(`  cleaned up ${report.removed}/${created} created record(s)`)
		return lines
	}

	lines.push(`  cleanup: removed ${report.removed}/${created} created record(s)`)
	if (report.unsupported.length > 0) {
		lines.push(
			`    ${report.unsupported.join(", ")} — no delete operation in the document, so records ` +
				"created for these entities remain. Declare x-cleanup to make them removable.",
		)
	}
	for (const failure of report.failed.slice(0, 5)) {
		lines.push(`    ${failure.entity} ${failure.id}: ${failure.reason}`)
	}
	if (report.failed.length > 5) lines.push(`    … and ${report.failed.length - 5} more`)
	return lines
}

/* Each one a record oat made and cannot remove: listed by the request that made it. */
function renderUnidentified(unidentified: readonly UnidentifiedCreate[]): string[] {
	if (unidentified.length === 0) return []
	const lines = [
		`  leftovers: ${unidentified.length} create(s) answered 2xx but no id could be read; the record may remain`,
	]
	for (const create of unidentified.slice(0, 5)) {
		lines.push(`    ${create.operationId} ${create.method} ${create.url} → ${create.status} (#${create.seq})`)
	}
	if (unidentified.length > 5) lines.push(`    … and ${unidentified.length - 5} more`)
	return lines
}
