/**
 * Storage contract shared by the reference backends.
 *
 * A store is deliberately dumb: it persists rows and answers "which rows match this predicate, in
 * this order". Parsing, validation, paging, projection and every defect that is not a property of
 * the engine itself live above it (see `query.ts` and `listing.ts`), so they are written once and
 * every engine exhibits them identically.
 *
 * What the engines are still free to disagree on is what engines genuinely disagree on: how they
 * compile a predicate, how their collations order text, and how their type systems store values.
 * Where two stores then disagree, that is a real difference, not two implementations drifting.
 *
 * Async throughout, because a real database is: SQLite implementations resolve immediately.
 */

import type { EntityDef } from "./model.ts"
import type { SelectPlan } from "./query.ts"

export type Row = Record<string, unknown>

export interface Store {
	close(): Promise<void>
	insert(entity: EntityDef, record: Row): Promise<Row>
	byId(entity: EntityDef, id: string | number): Promise<Row | null>
	update(entity: EntityDef, id: string | number, patch: Row): Promise<Row | null>
	remove(entity: EntityDef, id: string | number): Promise<void>
	/** Every row matching `plan.where`, ordered by `plan.order`. Paging happens above the store. */
	select(entity: EntityDef, plan: SelectPlan): Promise<Row[]>
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
