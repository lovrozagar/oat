/** What the server reads and writes on its own account: identities, uniqueness, derived counts, jobs. */

import type { EntityDef } from "../model/types.ts"
import { and } from "../query/tree.ts"
import type { FilterNode } from "../query-types.ts"
import type { Row } from "../store-api.ts"
import { HttpError } from "./errors.ts"
import { tombstoned, withDefaults } from "./records.ts"
import { type EntityRecord, type RecordKey, type ReferenceState, type Scope, TENANT_FIELD } from "./state.ts"
import { pathId } from "./validation.ts"

/** The path's parameters, each read as the type its entity declares. */
export async function typedScope(state: ReferenceState, raw: Record<string, string>): Promise<Scope> {
	const scope: Scope = {}
	for (const [param, value] of Object.entries(raw)) scope[param] = pathId(state.entities, param, value)
	if (state.shape.tableKey === "slug" && raw["table_id"] !== undefined) {
		scope["table_id"] = await tableByKey(state, String(scope["project_id"] ?? ""), raw["table_id"])
	}
	return scope
}

/**
 * The internal id of the table a path's `{table_id}` names. Under `tableKey: "slug"` that is the
 * slug, looked up in the path's project — two projects may each hold one — and, under
 * FOREIGN_PARENT_ACCEPTED, in any project when the path's has none. Elsewhere it is the id.
 */
export async function tableByKey(state: ReferenceState, projectId: string, raw: string): Promise<string | number> {
	const { table } = state
	if (state.shape.tableKey !== "slug") return pathId(state.entities, table.itemParam, raw)
	const named = await state.store.select(table, {
		collation: "binary",
		order: [],
		shuffleTies: false,
		where: { asText: false, field: "slug", kind: "cmp", nullsMatch: false, op: "eq", value: raw },
	})
	/* A live table before a deleted one: a slug is free again once its table is gone. */
	const live = named.toSorted((a, b) => Number(tombstoned(table, a)) - Number(tombstoned(table, b)))
	const found =
		live.find((row) => row[TENANT_FIELD] === projectId) ??
		(state.defects.has("FOREIGN_PARENT_ACCEPTED") ? live[0] : undefined)
	return found === undefined ? `${table.name}:missing:${raw}` : (found[table.identity] as string | number)
}

/** The live records of one parent scope — what uniqueness and derived counts range over. */
export async function liveRows(
	state: ReferenceState,
	entity: EntityDef,
	scope: Record<string, unknown>,
): Promise<Row[]> {
	const constraints: FilterNode[] = Object.entries(scope)
		.filter(([name, value]) => value !== undefined && entity.fields.some((field) => field.name === name))
		.map(([field, value]) => ({
			asText: false,
			field,
			kind: "cmp",
			nullsMatch: false,
			op: "eq",
			value: value as string,
		}))
	const soft = entity.softDeleteField
	const where = and(...constraints, soft === undefined ? null : { field: soft, kind: "isnull", negate: false })
	return state.store.select(entity, { collation: "binary", order: [], shuffleTies: false, where })
}

/** Refuses a record that repeats a unique set of another live one; `exceptId` is the record being rewritten. */
export async function assertUnique(state: ReferenceState, written: EntityRecord, exceptId?: string): Promise<void> {
	const { entity, record } = written
	if (state.defects.has("UNIQUE_NOT_ENFORCED")) return
	/* A slug names a table within its project, so it is unique there; the document does not say so. */
	const slugged = state.shape.tableKey === "slug" && entity.name === state.table.name
	const sets = [...(entity.unique ?? []), ...(slugged ? [["slug"]] : [])]
	if (sets.length === 0) return
	const scope: Row = {}
	for (const parent of entity.parents) scope[parent] = record[parent]
	scope[TENANT_FIELD] = record[TENANT_FIELD]
	const others = (await liveRows(state, entity, scope)).filter(
		(row) => exceptId === undefined || String(row[entity.identity]) !== exceptId,
	)
	const taken = sets.find((set) =>
		others.some((row) => set.every((col) => JSON.stringify(row[col]) === JSON.stringify(record[col]))),
	)
	if (taken !== undefined) throw new HttpError(409, "conflict", `unique constraint violated (${taken.join(", ")})`)
}

/**
 * Keeps a parent's derived count current after a child write.
 *
 * This is the behaviour `x-invalidate` promises: a write here changes what a *different* route
 * serves. Under the defect the promise is published and not kept, which is the common real
 * failure — a denormalised counter or a cached projection that nobody refreshes.
 */
export async function refreshParentCount(state: ReferenceState, entity: EntityDef, scope: Scope): Promise<void> {
	if (entity.name !== "row" || state.defects.has("PARENT_PROJECTION_STALE")) return
	const tableId = scope["table_id"]
	if (tableId === undefined) return
	const total = (await liveRows(state, entity, { table_id: tableId })).length
	await state.store.update(state.table, tableId, { row_count: total })
}

/**
 * PATCH without a lock: read the row, yield, then write every column back — the ORM
 * `save(entity)` pattern. Two concurrent patches to different fields, and the later write
 * reinstates the earlier field's old value. The yield makes the window observable rather than
 * dependent on scheduler luck; it runs only under the defect.
 */
export async function readModifyWrite(
	state: ReferenceState,
	{ entity, id }: RecordKey,
	patch: Row,
): Promise<Row | null> {
	const current = await state.store.byId(entity, id)
	if (current === null) return null
	await new Promise((resolve) => setTimeout(resolve, 15))
	return state.store.update(entity, id, { ...current, ...patch })
}

/**
 * Advances started jobs and writes the result back.
 *
 * Progress is persisted rather than computed per response, so a filter on `status` and the body it
 * returns describe the same state. Applied before every job read.
 */
export async function advanceJobs(state: ReferenceState): Promise<void> {
	if (state.defects.has("ASYNC_NEVER_COMPLETES")) return
	for (const [id, startedAt] of state.jobStartedAt) {
		const ratio = Math.min((Date.now() - startedAt) / 60, 1)
		const progress = Math.floor(ratio * 100)
		const status = ratio >= 1 ? "complete" : progress > 0 ? "running" : "pending"
		const current = await state.store.byId(state.job, id)
		if (current === null) {
			state.jobStartedAt.delete(id)
			continue
		}
		if (current["status"] === status && current["progress"] === progress) continue
		await state.store.update(state.job, id, { progress, status })
		if (status === "complete") state.jobStartedAt.delete(id)
	}
}

/**
 * Records that exist before oat arrives — what every real environment has.
 *
 * Names alternate case so binary and case-insensitive collations order them differently, some
 * descriptions are null, and values repeat, so the data looks like a lived-in collection rather
 * than a fixture. Written straight to the store: none of it is oat's to clean up.
 */
export async function prepopulate(state: ReferenceState, perTenant: number): Promise<void> {
	for (const [projectId, count] of [
		["proj_alpha", perTenant],
		["proj_beta", Math.ceil(perTenant / 10)],
	] as const) {
		for (let i = 0; i < count; i++) await prepopulateOne(state, projectId, i)
	}
}

const WORDS = ["apple", "Banana", "cherry", "Date", "elder", "Fig", "grape", "Honeydew", "kiwi", "Lemon"]

async function prepopulateOne(state: ReferenceState, projectId: string, i: number): Promise<void> {
	const word = WORDS[i % WORDS.length] as string
	const name = `${word} ${projectId === "proj_alpha" ? "" : "beta "}${String(i).padStart(4, "0")}`
	const scope = { project_id: projectId }
	const table = withDefaults(
		state,
		{ entity: state.table, scope },
		{
			description: i % 3 === 0 ? null : `pre-existing ${word.toLowerCase()} record`,
			name,
			position: (i * 7) % 100,
			slug: name.toLowerCase().replace(/\s+/g, "-"),
			status: ["active", "draft", "archived"][i % 3],
		},
	)
	await state.store.insert(state.table, table)
	const job = withDefaults(
		state,
		{ entity: state.job, scope },
		{ kind: ["export", "import", "sync"][i % 3], name, note: i % 4 === 0 ? null : word },
	)
	job["status"] = "complete"
	job["progress"] = 100
	await state.store.insert(state.job, job)
}
