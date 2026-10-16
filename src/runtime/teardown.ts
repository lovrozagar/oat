/**
 * Teardown of everything a run created.
 *
 * A tester that leaves its fixtures behind is a tester nobody runs twice against anything real.
 * Records are unwound newest-first so children go before the parents they depend on, and every
 * failure is collected rather than thrown — a teardown that aborts halfway is worse than one that
 * reports exactly what it could not remove.
 */

import type { RemovalVerdict, RemovedRecord } from "../config/define-config.ts"
import { largestPageQuery, type OperationModel, type SpecModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import { parseRouteRef } from "../spec/load.ts"
import { FencedError } from "./fence.ts"
import { isNetworkError } from "./network.ts"
import { fillPath, idOf, recordsFromList } from "./world.ts"
import { readPath } from "./path.ts"
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
	/** Records still in place, each with the principal that created it. */
	failed: Array<{ entity: string; id: string; principal: string; reason: string }>
	unsupported: string[]
	/** Every record the unwind was given, in creation order, its creator, and whether it is gone now. */
	records: Array<{ entity: string; id: string; principal: string; removed: boolean }>
	/** Creates whose record oat could not identify, so could not remove. Each fails the run. */
	unidentified: UnidentifiedCreate[]
	/** What `hooks.verifyRemoved` threw, once per call that did; those records keep teardown's verdict. */
	verifyHookErrors?: string[]
}

export const NEVER_SEEN = "its creator could never read it back, so teardown cannot tell whether it is gone"
export const VERIFY_HOOK_PRESENT = "hooks.verifyRemoved says it is still present"

export interface UnwindOptions {
	onItem?: (done: number, total: number, item: Disposable) => void
	/* Read each list again afterwards, so a 2xx delete that kept its record is not counted gone. */
	verify?: boolean
	/* Asked about every record counted removed and every one teardown could not show gone. */
	verifyRemoved?: (record: RemovedRecord) => RemovalVerdict | Promise<RemovalVerdict>
}

/* Calls to `hooks.verifyRemoved` at once. */
const VERIFY_HOOK_CONCURRENCY = 4

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
		this.sightings.add(`${entity}\u0000${id}\u0000${principal}`)
	}

	private seenByCreator(item: Disposable): boolean {
		return this.sightings.has(`${item.entity}\u0000${item.id}\u0000${item.owner.id}`)
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

	/* One read of the record with its creator's credential; a 2xx is the sighting it lacked. */
	private async readBack(model: SpecModel, client: Client, item: Disposable): Promise<void> {
		const read = readPathOf(model, item)
		if (read === null) return
		try {
			const exchange = await client.get(read.path, { headers: item.owner.headers(), operationId: read.op.operationId })
			if (exchange.status >= 200 && exchange.status < 300) this.sighted(item.entity, item.id, item.owner.id)
		} catch (error) {
			if (!(error instanceof FencedError) && !isNetworkError(error)) throw error
		}
	}

	async unwind(
		model: SpecModel,
		client: Client,
		/* Principals allowed to remove a record its creator was refused, strongest first — the
		 * same tenant's owner removing what a member created. */
		fallbacks: (owner: Owner) => Owner[],
		options: UnwindOptions = {},
	): Promise<TeardownReport> {
		const { onItem, verify = true } = options
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
		const records = new Map(
			queue.map((item) => [item, { entity: item.entity, id: item.id, principal: item.owner.id, removed: false }]),
		)
		const earlierDeletes = new Set(
			client.transcript
				.filter((exchange) => exchange.method === "DELETE" && exchange.status >= 200 && exchange.status < 300)
				.map((exchange) => new URL(exchange.url).pathname),
		)
		const earlierSegments = [...earlierDeletes].map(segmentsOf)
		/* The path itself, or an ancestor of it, removed earlier in the run — compared by segments,
		 * so `/tables/1` is never `/tables/11`. Earlier paths carry the base path; this one does not. */
		const deletedEarlier = (path: string): boolean => {
			const target = segmentsOf(path.split("?")[0] ?? path)
			return earlierSegments.some((done) => {
				for (let k = target.length; k >= 1; k--) {
					if (done.length >= k && done.slice(-k).every((segment, at) => segment === target[at])) return true
				}
				return false
			})
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
					principal: item.owner.id,
					reason: error instanceof Error ? error.message : String(error),
				})
				done += 1
				return
			}

			const moved = this.movedAway.get(`${item.entity}\u0000${item.id}`)
			try {
				const attempts: string[] = []
				let removed = false
				for (const [index, deleter] of [item.owner, ...fallbacks(item.owner)].entries()) {
					const exchange = await client.request("DELETE", path, { headers: deleter.headers })
					attempts.push(`${deleter.id}: ${exchange.status}`)
					/* Gone is the goal, not a successful call — but only the creator's 404 says the
					 * record is gone. Anyone else's may just mean they cannot see it. */
					if (
						exchange.status < 300 ||
						(index === 0 && moved === undefined && (exchange.status === 404 || exchange.status === 410))
					) {
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
						principal: item.owner.id,
						reason: `${moved === undefined ? "" : `${moved}; `}DELETE ${path} returned ${attempts.join(", ")}`,
					})
				}
			} catch (error) {
				report.failed.push({
					entity: item.entity,
					id: item.id,
					principal: item.owner.id,
					reason: error instanceof Error ? error.message : String(error),
				})
			}
			done += 1
			onItem?.(done, queue.length, item)
		}
		for (const level of levels) {
			const removing = queue.filter((item) => depthOf(item) === level)
			/* A record its creator never read back is read once, with the creator's credential. */
			await Promise.all(
				removing.filter((item) => !this.seenByCreator(item)).map((item) => this.readBack(model, client, item)),
			)
			await Promise.all(removing.map(remove))
			/* Before the parents go: a removed parent takes with it the list its children are read in. */
			if (verify) await verifyGone(model, client, removing, records, report)
		}

		/* Gone by every sign HTTP gives, yet its creator never saw it: no sign could have shown it. */
		const neverSeen = new Set<Disposable>()
		for (const item of queue) {
			const record = records.get(item)
			if (record?.removed !== true || this.seenByCreator(item) || readPathOf(model, item) === null) continue
			const path = deletePathOf(model, item)
			if (path !== null && deletedEarlier(path)) continue
			record.removed = false
			report.removed -= 1
			report.failed.push({ entity: item.entity, id: item.id, principal: item.owner.id, reason: NEVER_SEEN })
			neverSeen.add(item)
		}
		if (options.verifyRemoved !== undefined) {
			await askVerifyHook(options.verifyRemoved, queue, records, neverSeen, report)
		}
		report.unsupported = [...unsupported]
		report.records = [...records.values()].toReversed()
		return report
	}
}

/** Path segments, decoded, without empty ones. */
function segmentsOf(pathname: string): string[] {
	return pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
}

/** The record's own read path, or `null` when its entity has no read it can fill. */
function readPathOf(model: SpecModel, item: Disposable): { op: OperationModel; path: string } | null {
	const readId = model.entities.get(item.entity)?.read
	const op = readId === undefined ? undefined : model.byOperationId.get(readId)
	const param = op?.pathParams.at(-1)
	if (op === undefined || param === undefined) return null
	try {
		return { op, path: fillPath(op.path, { ...item.scope, [param]: item.id }) }
	} catch {
		return null
	}
}

function deletePathOf(model: SpecModel, item: Disposable): string | null {
	const op = deleteOperationFor(item.entity, model)
	if (op === null) return null
	const param = op.pathParams.at(-1)
	try {
		return fillPath(op.path, param === undefined ? item.scope : { ...item.scope, [param]: item.id })
	} catch {
		return null
	}
}

/**
 * Applies `hooks.verifyRemoved` to every record counted removed and every one never seen, a few at
 * a time: `present` makes a leftover, `absent` clears a never-seen record, `unknown` — or a throw —
 * leaves teardown's own verdict.
 */
async function askVerifyHook(
	hook: NonNullable<UnwindOptions["verifyRemoved"]>,
	queue: readonly Disposable[],
	records: ReadonlyMap<Disposable, { removed: boolean }>,
	neverSeen: ReadonlySet<Disposable>,
	report: TeardownReport,
): Promise<void> {
	const asked = queue.filter((item) => records.get(item)?.removed === true || neverSeen.has(item))
	const errors: string[] = []
	const answer = async (item: Disposable): Promise<RemovalVerdict> => {
		try {
			return await hook({ entity: item.entity, id: item.id, principal: item.owner.id, scope: { ...item.scope } })
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error))
			return "unknown"
		}
	}
	for (let at = 0; at < asked.length; at += VERIFY_HOOK_CONCURRENCY) {
		const batch = asked.slice(at, at + VERIFY_HOOK_CONCURRENCY)
		const verdicts = await Promise.all(batch.map(answer))
		batch.forEach((item, index) => {
			const verdict = verdicts[index]
			const record = records.get(item)
			if (record === undefined || verdict === "unknown") return
			const failure = report.failed.findIndex(
				(entry) => entry.entity === item.entity && entry.id === item.id && entry.reason === NEVER_SEEN,
			)
			if (verdict === "absent") {
				if (failure < 0) return
				report.failed.splice(failure, 1)
				record.removed = true
				report.removed += 1
				return
			}
			if (failure >= 0) report.failed.splice(failure, 1)
			else {
				record.removed = false
				report.removed -= 1
			}
			report.failed.push({ entity: item.entity, id: item.id, principal: item.owner.id, reason: VERIFY_HOOK_PRESENT })
		})
	}
	if (errors.length > 0) report.verifyHookErrors = errors
}

export const STILL_LISTED = "delete answered 2xx but the record is still listed"

/* The most pages one re-list reads: teardown looks for its own records, it does not crawl. */
const VERIFY_PAGES = 50

interface ListGroup {
	identity: string
	listOp: OperationModel
	owner: Owner
	path: string
	items: Disposable[]
}

/**
 * The list a removed record lived in, read again with its creator's credential: a record still
 * listed is a leftover, whatever its delete answered. A read that cannot be sent — fenced, or the
 * network gone — verifies nothing and claims nothing.
 */
async function verifyGone(
	model: SpecModel,
	client: Client,
	queue: readonly Disposable[],
	records: ReadonlyMap<Disposable, { removed: boolean }>,
	report: TeardownReport,
): Promise<void> {
	const groups = new Map<string, ListGroup>()
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
		const listed = await stillListed(model, client, group)
		if (listed === null) continue
		for (const item of group.items) {
			const record = records.get(item)
			if (record === undefined || !listed.has(item.id)) continue
			record.removed = false
			report.removed -= 1
			report.failed.push({ entity: item.entity, id: item.id, principal: item.owner.id, reason: STILL_LISTED })
		}
	}
}

/**
 * Which of the group's records its list still holds, read page by page as the list declares its
 * paging, until the list ends or every one of them has been seen. `null` when the first page could
 * not be read: nothing is claimed either way.
 */
async function stillListed(model: SpecModel, client: Client, group: ListGroup): Promise<Set<string> | null> {
	const paging = group.listOp.conventions
	const first = largestPageQuery(model, group.listOp)
	const wanted = new Set(group.items.map((item) => item.id))
	const listed = new Set<string>()
	const seen = new Set<string>()
	/* The longest page served: a server may cap the size asked for without saying so. */
	let fullPage = 0
	/* Rows served so far, repeats included: what an offset counts. */
	let served = 0
	let cursor: string | undefined
	for (let index = 0; index < VERIFY_PAGES; index++) {
		const query: Record<string, string | number> = { ...first }
		if (index > 0) {
			if (paging.page !== undefined) query[paging.page] = index + 1
			else if (paging.offset !== undefined) query[paging.offset] = served
			else if (paging.cursor !== undefined && cursor !== undefined) query[paging.cursor] = cursor
			else break
		}
		let exchange: Exchange
		try {
			exchange = await client.get(group.path, {
				headers: group.owner.headers(),
				operationId: group.listOp.operationId,
				query,
			})
		} catch (error) {
			if (!(error instanceof FencedError) && !isNetworkError(error)) throw error
			return index === 0 ? null : listed
		}
		if (exchange.status >= 300) return index === 0 ? null : listed
		const rows = recordsFromList(exchange.responseBody, group.listOp.collection?.key ?? null)
		served += rows.length
		const ids = rows.flatMap((row) => idOf(row, group.identity) ?? [])
		const fresh = ids.filter((id) => !seen.has(id))
		for (const id of ids) {
			seen.add(id)
			if (wanted.has(id)) listed.add(id)
		}
		/* An empty page, the same page again, or one shorter than a full page already served ends it. */
		if (fresh.length === 0 || listed.size === wanted.size) break
		if (fullPage > 0 && rows.length < fullPage) break
		fullPage = Math.max(fullPage, rows.length)
		const next =
			paging.envelope.nextCursor === undefined ? undefined : readPath(exchange.responseBody, paging.envelope.nextCursor)
		cursor = typeof next === "string" && next !== "" ? next : undefined
	}
	return listed
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
		lines.push(`    ${failure.entity} ${failure.id} (as ${failure.principal}): ${failure.reason}`)
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
