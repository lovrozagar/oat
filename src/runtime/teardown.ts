/**
 * Teardown of everything a run created.
 *
 * A tester that leaves its fixtures behind is a tester nobody runs twice against anything real.
 * Records are unwound newest-first so children go before the parents they depend on, and every
 * failure is collected rather than thrown — a teardown that aborts halfway is worse than one that
 * reports exactly what it could not remove.
 */

import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { Client } from "./client.ts"
import { parseRouteRef } from "../spec/load.ts"
import { fillPath } from "./world.ts"

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

export interface TeardownReport {
	removed: number
	failed: Array<{ entity: string; id: string; reason: string }>
	unsupported: string[]
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

	record(entity: string, id: string, scope: Record<string, string>, owner: Owner): void {
		if (id === "" || id === "undefined") return
		const key = `${entity}\u0000${id}`
		if (this.seen.has(key)) return
		this.seen.add(key)
		this.items.push({ entity, id, owner, scope: { ...scope } })
	}

	get size(): number {
		return this.items.length
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
	): Promise<TeardownReport> {
		const report: TeardownReport = { failed: [], removed: 0, unsupported: [] }
		const unsupported = new Set<string>()

		/*
		 * Deepest first, one level at a time, and every record within a level at once. A record's
		 * depth is how many path parameters its delete route takes: a child's route carries its
		 * parent's parameters and its own, so a level never holds a record and its parent.
		 * Newest first within a level keeps the order the creation sequence implies.
		 */
		const queue = [...this.items].reverse()
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
				if (removed) report.removed += 1
				else {
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

		report.unsupported = [...unsupported]
		return report
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
	if (created === 0) return []
	const lines: string[] = []

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
