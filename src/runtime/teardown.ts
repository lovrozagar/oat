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

export interface Disposable {
	entity: string
	id: string
	/** Path parameters in scope when the record was created. */
	scope: Record<string, string>
}

export interface TeardownReport {
	removed: number
	failed: Array<{ entity: string; id: string; reason: string }>
	unsupported: string[]
}

/**
 * Registry of what a run brought into existence. Entities are recorded in creation order so the
 * unwind can reverse it.
 */
export class Ledger {
	private readonly items: Disposable[] = []

	record(entity: string, id: string, scope: Record<string, string>): void {
		if (id === "" || id === "undefined") return
		this.items.push({ entity, id, scope: { ...scope } })
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
		headers: () => Record<string, string>,
		onItem?: (done: number, total: number, item: Disposable) => void,
	): Promise<TeardownReport> {
		const report: TeardownReport = { failed: [], removed: 0, unsupported: [] }
		const unsupported = new Set<string>()

		/* Newest first: a child created inside a parent must be removed before the parent, and
		 * creation order already encodes that dependency. */
		const queue = [...this.items].reverse()
		let done = 0
		for (const item of queue) {
			onItem?.(done, queue.length, item)
			const deleteOp = deleteOperationFor(item.entity, model)
			if (deleteOp === null) {
				unsupported.add(item.entity)
				done += 1
				continue
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
				continue
			}

			try {
				const exchange = await client.request("DELETE", path, { headers })
				/* 404 means it is already gone — the goal is absence, not a successful call. */
				if (exchange.status < 300 || exchange.status === 404 || exchange.status === 410) {
					report.removed += 1
				} else {
					report.failed.push({
						entity: item.entity,
						id: item.id,
						reason: `DELETE ${path} returned ${exchange.status}`,
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
