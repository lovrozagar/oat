/** A record as the server makes it and as it leaves the server. */

import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import { writableFields } from "../model/fields.ts"
import type { Row } from "../store-api.ts"
import type { Collection, EntityRecord, ReferenceState, Scope } from "./state.ts"
import { emptyValue } from "./validation.ts"

/** 48 KiB per record: six of them make one listing page larger than 256 KiB. */
const PADDING = /* @__PURE__ */ "oat reference padding · ".repeat(2100).slice(0, 49_152)

/* The control value of oat's payload probe, the first it writes to a fresh record. */
const HIDDEN_TEXT = "oat-payload-probe"

/** Under HIDDEN_FROM_CREATOR: a row holding the payload probe's control value, served to nobody. */
export function hiddenFromCreator(defects: DefectSet, entity: EntityDef, record: Row): boolean {
	return (
		defects.has("HIDDEN_FROM_CREATOR") &&
		entity.name === "row" &&
		Object.values(record).some((value) => value === HIDDEN_TEXT)
	)
}

export function tombstoned(entity: EntityDef, record: Row): boolean {
	return entity.softDeleteField !== undefined && record[entity.softDeleteField] !== null
}

/** A record as it leaves the server: write-only fields never do. */
export function present(state: ReferenceState, entity: EntityDef, record: Row): Row {
	return shown(state, entity, decorate(state.defects, record))
}

/**
 * A record as every answer shows it, the listing's rows too: without its write-only fields, and
 * under `relatedRecord` with the related one nested.
 */
export function shown(state: ReferenceState, entity: EntityDef, record: Row): Row {
	const out = { ...record }
	for (const field of entity.fields) if (field.writeOnly === true) delete out[field.name]
	/* Under `relatedRecord`, each record carries a related one with an id of its own. That id is 1 —
	 * the id of a real record too, so a tester that takes it for the record's own deletes somebody
	 * else's row, and the bystander check sees it. */
	if (state.shape.relatedRecord !== true) return out
	return { ...out, Status: { [state.shape.identityField ?? "id"]: 1, Name: "open" } }
}

function decorate(defects: DefectSet, record: Row): Row {
	if (!defects.has("RESPONSE_SCHEMA_DRIFT")) return record
	return { ...record, _internal_revision: 7, _shard: "shard-a" }
}

/**
 * Rewrites a field in the *collection* projection only.
 *
 * Applied where the listing is built, never on the item route, so the two disagree exactly as a
 * stale denormalized listing would. The value is plausible rather than obviously wrong: a
 * projection that returned garbage would be caught by schema validation instead.
 */
export function skewForList(defects: DefectSet, record: Row): Row {
	if (!defects.has("LIST_DETAIL_DISAGREE") || typeof record["name"] !== "string") return record
	return { ...record, name: `${record["name"]} (listing)` }
}

/* Under `recordEnvelope`: what each answer carries. The async job is an action's receipt, not a
 * record, and keeps its plain answers. */
export function wraps(state: ReferenceState, entity: EntityDef): boolean {
	return state.shape.recordEnvelope === true && entity.name !== state.job.name
}

export function answerCreated(state: ReferenceState, entity: EntityDef, record: Row): Row {
	if (!wraps(state, entity)) return record
	return { data: record, id: record[entity.identity], message: "created", success: true }
}

export function answerRead(state: ReferenceState, entity: EntityDef, record: Row): Row {
	return wraps(state, entity) ? { data: record, fields: fieldList(entity) } : record
}

export function answerWritten(state: ReferenceState, { entity, record }: EntityRecord, message: string): Row {
	return wraps(state, entity) ? { id: record[entity.identity], message, success: true } : record
}

/** The readable fields, as an envelope lists them beside the record. */
export function fieldList(entity: EntityDef): Row[] {
	return entity.fields
		.filter((field) => field.writeOnly !== true)
		.map((field) => ({ name: field.name, type: field.type }))
}

/** A new record: its id, parents, timestamps, and every field nobody supplied. */
export function withDefaults(state: ReferenceState, { entity, scope }: Collection, input: Row): Row {
	const record: Row = { ...input }
	record[entity.identity] = state.ids.next(entity)
	for (const parent of entity.parents) {
		if (entity.fields.some((f) => f.name === parent)) record[parent] = scope[parent] ?? null
	}
	record["created_at"] = state.ids.now()
	record["updated_at"] = state.ids.now()
	if (entity.softDeleteField !== undefined) record[entity.softDeleteField] = null
	/* A server-generated field large enough that one page of records exceeds 256 KiB. */
	if (entity.fields.some((field) => field.name === "padding")) record["padding"] = PADDING
	if (state.shape.tableKey === "slug" && entity.name === state.table.name) {
		record["slug"] = slugify(String(record["name"] ?? ""))
		state.slugOf.set(String(record[entity.identity]), record["slug"] as string)
	}
	for (const field of entity.fields) {
		if (record[field.name] === undefined) record[field.name] = emptyValue(field)
	}
	return record
}

/** Defaults for a replacing update: every writable field the body leaves out is reset. */
export function replacementDefaults(entity: EntityDef): Row {
	const out: Row = {}
	for (const field of writableFields(entity, "update")) out[field.name] = emptyValue(field)
	return out
}

/* `Quarterly Report 0` → `quarterly-report-0`. */
function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

/** The key a collection's STALE_LIST snapshot is kept under. */
export function snapshotKey(entity: EntityDef, scope: Scope): string {
	return `${entity.name}:${scope["project_id"] ?? ""}:${scope["table_id"] ?? ""}`
}
