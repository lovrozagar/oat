/**
 * In-memory storage for the reference backend.
 *
 * The zero-dependency fallback: no database, no flags, no server to have running. It evaluates the
 * query AST in JavaScript, which is exactly why the SQL stores exist alongside it — a JS store
 * cannot exhibit an engine's collation or type affinity, so a check that only ever runs here has
 * not been proven against anything a real backend does.
 */

import type { EntityDef } from "../model/types.ts"
import type { SelectPlan } from "../query-types.ts"
import { compareRows } from "../query/compare.ts"
import { evaluate } from "../query/evaluate.ts"
import type { Row, Store } from "../store-api.ts"

export class MemoryStore implements Store {
	private readonly tables = new Map<string, Map<string, Row>>()
	/**
	 * Per entity, advances per shuffled query so tied rows land differently each time — see
	 * UNSTABLE_SORT. Kept per entity, so one lane's queries never move another's: lanes answer in
	 * whatever order the server is scheduled, and a shared count would make the defect's report
	 * depend on that timing.
	 */
	private readonly rotations = new Map<string, number>()

	async close(): Promise<void> {
		this.tables.clear()
		this.rotations.clear()
	}

	private collection(entity: EntityDef): Map<string, Row> {
		const existing = this.tables.get(entity.name)
		if (existing !== undefined) return existing
		const created = new Map<string, Row>()
		this.tables.set(entity.name, created)
		return created
	}

	async insert(entity: EntityDef, record: Row): Promise<Row> {
		const stored = { ...record }
		this.collection(entity).set(String(record[entity.identity]), stored)
		return { ...stored }
	}

	async byId(entity: EntityDef, id: string | number): Promise<Row | null> {
		const found = this.collection(entity).get(String(id))
		return found === undefined ? null : { ...found }
	}

	async update(entity: EntityDef, id: string | number, patch: Row): Promise<Row | null> {
		const existing = this.collection(entity).get(String(id))
		if (existing === undefined) return null
		const next = { ...existing, ...patch }
		this.collection(entity).set(String(id), next)
		return { ...next }
	}

	async remove(entity: EntityDef, id: string | number): Promise<void> {
		this.collection(entity).delete(String(id))
	}

	async select(entity: EntityDef, plan: SelectPlan): Promise<Row[]> {
		let rows = [...this.collection(entity).values()].filter((row) => evaluate(plan.where, row))
		/* Array.prototype.sort is stable, so dropping the tiebreak alone would still yield one
		 * deterministic order and the defect would be unobservable. A database without a tiebreak
		 * returns tied rows in whatever order the plan produced, varying between queries; rotating
		 * the input reproduces that. */
		if (plan.shuffleTies && rows.length > 1) {
			const rotation = ((this.rotations.get(entity.name) ?? 0) + 1) % rows.length
			this.rotations.set(entity.name, rotation)
			rows = [...rows.slice(rotation), ...rows.slice(0, rotation)]
		}
		return rows.sort(compareRows(plan.order, plan.collation)).map((row) => ({ ...row }))
	}
}
