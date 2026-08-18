/**
 * In-memory storage for the reference backend.
 *
 * The zero-dependency fallback: no database, no flags, no server to have running. It executes the
 * query grammar in JavaScript, which is exactly why the SQL stores exist alongside it — a JS
 * store cannot exhibit NULL ordering, collation, or type-discipline behaviour, so a check that
 * only ever runs here has not been proven against anything a real backend does.
 */

import type { DefectSet } from "../defects.ts"
import type { EntityDef } from "../model.ts"
import { OVERCLAIMED_FIELD, fieldsWhere } from "../model.ts"
import { runQuery, type Row as QueryRow } from "../query.ts"
import type { QueryOptions, QueryParams, QueryResult, Row, Store } from "../store-api.ts"

export class MemoryStore implements Store {
	private readonly tables = new Map<string, Map<string, Row>>()
	private sequence = 0

	constructor(private readonly defects: DefectSet) {}

	async close(): Promise<void> {
		this.tables.clear()
	}

	private collection(entity: EntityDef): Map<string, Row> {
		const existing = this.tables.get(entity.name)
		if (existing !== undefined) return existing
		const created = new Map<string, Row>()
		this.tables.set(entity.name, created)
		return created
	}

	nextId(prefix: string): string {
		this.sequence += 1
		return `${prefix}_${String(this.sequence).padStart(6, "0")}`
	}

	now(): number {
		/* Derived from the sequence rather than the clock: wall-clock timestamps make ordering
		 * assertions flaky for reasons that have nothing to do with the backend. */
		return 1_700_000_000_000 + this.sequence * 1000
	}

	async insert(entity: EntityDef, record: Row): Promise<Row> {
		const stored = { ...record }
		this.collection(entity).set(String(record[entity.identity]), stored)
		return { ...stored }
	}

	async byId(entity: EntityDef, id: string): Promise<Row | null> {
		const found = this.collection(entity).get(id)
		return found === undefined ? null : { ...found }
	}

	async update(entity: EntityDef, id: string, patch: Row): Promise<Row | null> {
		const existing = this.collection(entity).get(id)
		if (existing === undefined) return null
		const next = { ...existing, ...patch }
		this.collection(entity).set(id, next)
		return { ...next }
	}

	async remove(entity: EntityDef, id: string): Promise<void> {
		this.collection(entity).delete(id)
	}

	async query(
		entity: EntityDef,
		scope: Record<string, string>,
		params: QueryParams,
		options: QueryOptions,
	): Promise<QueryResult> {
		/* Ancestor scoping — `.../tables/{table_id}/rows` lists that table only. The defect keeps
		 * scoping on the plain listing but drops it once a filter is present, which is how a
		 * filter turns into an authorization bypass. */
		const scoped = !(this.defects.has("TENANT_LEAK_VIA_FILTER") && params.filter !== undefined)
		let source = [...this.collection(entity).values()]
		for (const parent of scoped ? entity.parents : []) {
			const value = scope[parent]
			if (value === undefined) continue
			if (!entity.fields.some((f) => f.name === parent)) continue
			source = source.filter((row) => String(row[parent]) === value)
		}

		const result = runQuery(
			source as QueryRow[],
			params,
			{
				defaultLimit: entity.defaultLimit,
				/* Under the overclaim defect the backend refuses a field the document still declares
				 * filterable. The backend is not wrong to refuse — the document is wrong to promise. */
				filterable: this.defects.has("SPEC_OVERCLAIMS_FILTERABLE")
					? fieldsWhere(entity, "filterable").filter((f) => f !== OVERCLAIMED_FIELD)
					: fieldsWhere(entity, "filterable"),
				/* Same overclaim shape, applied to the select role: the document still lists the field,
				 * the backend now refuses to project it. */
				excludedSelect: this.defects.has("SPEC_OVERCLAIMS_SELECTABLE") ? [OVERCLAIMED_FIELD] : [],
				identity: entity.identity,
				maxLimit: entity.maxLimit,
				searchable: fieldsWhere(entity, "searchable"),
				/* Same overclaim shape as filterable, one role over: the document still promises the
				 * field can be sorted by; the backend refuses it. */
				sortable: this.defects.has("SPEC_OVERCLAIMS_SORTABLE")
					? fieldsWhere(entity, "sortable").filter((f) => f !== OVERCLAIMED_FIELD)
					: fieldsWhere(entity, "sortable"),
				...(options.softDeleteField === undefined ? {} : { softDeleteField: options.softDeleteField }),
				...(entity.filterCatalog?.emptyIn === undefined ? {} : { emptyIn: entity.filterCatalog.emptyIn }),
				...(entity.filterCatalog?.maxInValues === undefined ? {} : { maxInValues: entity.filterCatalog.maxInValues }),
				...(entity.filterCatalog?.maxFilterConditions === undefined
					? {}
					: { maxFilterConditions: entity.filterCatalog.maxFilterConditions }),
				...(entity.filterCatalog?.opsByField === undefined
					? {}
					: { allowedOpsByField: entity.filterCatalog.opsByField }),
				...(entity.filterCatalog?.selectUnknown === undefined
					? {}
					: { selectUnknown: entity.filterCatalog.selectUnknown }),
			},
			this.defects,
			options.transform,
		)

		return result
	}
}
