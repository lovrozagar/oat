/** A seeded in-memory store for the listing tests, and a wrapper that records what it was asked. */

import { DefectSet } from "../../defects/defect-set.ts"
import type { DefectName } from "../../defects/table.ts"
import { TABLE } from "../../model/table.ts"
import type { EntityDef } from "../../model/types.ts"
import { DEFAULT_CONVENTIONS, type ParseContext } from "../../query/conventions.ts"
import type { SelectPlan } from "../../query-types.ts"
import type { Row, Store } from "../../store-api.ts"
import { MemoryStore } from "../../stores/memory.ts"

/** Six tables in proj_alpha (one soft-deleted) and one in proj_beta, ids in creation order. */
export const TABLE_ROWS: readonly Row[] = [
	{
		created_at: 1,
		deleted_at: null,
		description: null,
		id: "t1",
		name: "alpha",
		position: 3,
		project_id: "proj_alpha",
		slug: "a",
		status: "active",
	},
	{
		created_at: 2,
		deleted_at: null,
		description: "x",
		id: "t2",
		name: "Beta",
		position: 1,
		project_id: "proj_alpha",
		slug: "b",
		status: "draft",
	},
	{
		created_at: 3,
		deleted_at: 9,
		description: "y",
		id: "t3",
		name: "gamma",
		position: 2,
		project_id: "proj_alpha",
		slug: "c",
		status: "active",
	},
	{
		created_at: 4,
		deleted_at: null,
		description: null,
		id: "t4",
		name: "Delta",
		position: null,
		project_id: "proj_alpha",
		slug: "d",
		status: "archived",
	},
	{
		created_at: 5,
		deleted_at: null,
		description: "z",
		id: "t5",
		name: "eps",
		position: 5,
		project_id: "proj_alpha",
		slug: "e",
		status: "active",
	},
	{
		created_at: 6,
		deleted_at: null,
		description: "w",
		id: "t6",
		name: "zeta",
		position: 4,
		project_id: "proj_alpha",
		slug: "f",
		status: "draft",
	},
	{
		created_at: 7,
		deleted_at: null,
		description: null,
		id: "t7",
		name: "other",
		position: 1,
		project_id: "proj_beta",
		slug: "g",
		status: "active",
	},
]

export async function seededStore(rows: readonly Row[] = TABLE_ROWS, entity: EntityDef = TABLE): Promise<MemoryStore> {
	const store = new MemoryStore()
	for (const row of rows) await store.insert(entity, row)
	return store
}

/** The store, with every select it answers recorded as the plan it was given. */
export function recording(store: Store): { store: Store; plans: SelectPlan[] } {
	const plans: SelectPlan[] = []
	const recorded: Store = {
		byId: (entity, id) => store.byId(entity, id),
		close: () => store.close(),
		insert: (entity, record) => store.insert(entity, record),
		remove: (entity, id) => store.remove(entity, id),
		select: (entity, plan) => {
			plans.push(plan)
			return store.select(entity, plan)
		},
		update: (entity, id, patch) => store.update(entity, id, patch),
	}
	return { plans, store: recorded }
}

export function parseContext(defects: readonly DefectName[] = [], entity: EntityDef = TABLE): ParseContext {
	return { conventions: DEFAULT_CONVENTIONS, defects: new DefectSet(defects), entity }
}
