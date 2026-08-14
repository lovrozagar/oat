/**
 * Storage contract shared by the reference backends.
 *
 * One HTTP server implementation runs against every store, so a defect is defined once and
 * exercised on each engine. Where two engines disagree about what a defect *does*, that is
 * itself the finding — SQLite and Postgres differ on NULL ordering, type discipline, collation
 * and case-insensitive matching, and those are exactly the semantics oat's checks reason about.
 *
 * Async throughout, because a real database is: SQLite implementations resolve immediately.
 */

import type { EntityDef } from "./model.ts"

export type Row = Record<string, unknown>

export interface QueryParams {
	filter?: string | undefined
	order?: string | undefined
	select?: string | undefined
	q?: string | undefined
	limit?: number | undefined
	page?: number | undefined
	cursor?: string | undefined
}

export interface QueryOptions {
	softDeleteField?: string | undefined
	/**
	 * Applied to each row *before* the sparse fieldset, so a derived value cannot reintroduce a
	 * column the caller deselected.
	 */
	transform?: ((row: Row) => Row) | undefined
}

export interface QueryResult {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number | null
	limit: number
}

export interface Store {
	close(): Promise<void>
	nextId(prefix: string): string
	now(): number
	insert(entity: EntityDef, record: Row): Promise<Row>
	byId(entity: EntityDef, id: string): Promise<Row | null>
	update(entity: EntityDef, id: string, patch: Row): Promise<Row | null>
	remove(entity: EntityDef, id: string): Promise<void>
	query(
		entity: EntityDef,
		scope: Record<string, string>,
		params: QueryParams,
		options: QueryOptions,
	): Promise<QueryResult>
}

/** Raised for input the storage layer rejects — surfaces as 400, or 500 under the defect. */
export class SqlError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

export function encodeCursor(id: string): string {
	return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url")
}

export function decodeCursor(cursor: string): string {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: string }
		if (typeof parsed.id !== "string") throw new Error("missing id")
		return parsed.id
	} catch {
		throw new SqlError("invalid_cursor", "cursor is not a value produced by this API")
	}
}

/** Splits on commas at paren depth zero — shared by the filter and order grammars. */
export function splitTopLevel(input: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === "," && depth === 0) {
			parts.push(input.slice(start, i))
			start = i + 1
		}
	}
	parts.push(input.slice(start))
	return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

export function stripParens(value: string): string {
	return value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value
}

export function project(
	row: Row,
	select: string | undefined,
	ignore: boolean,
	/* Fields the document still declares selectable that the backend has stopped honouring — see
	 * SPEC_OVERCLAIMS_SELECTABLE. Everything else stays as permissive as before: an unrecognised
	 * field is silently dropped, never rejected. */
	excluded: readonly string[] = [],
): Row {
	if (select === undefined || select === "" || select === "*") return { ...row }
	if (ignore) return { ...row }
	const fields = select.split(",").map((s) => s.trim()).filter(Boolean)
	const rejected = fields.find((f) => excluded.includes(f))
	if (rejected !== undefined) {
		throw new SqlError("invalid_select", `field "${rejected}" is not selectable`)
	}
	const out: Row = {}
	for (const field of fields) {
		if (Object.hasOwn(row, field)) out[field] = row[field]
	}
	return out
}
