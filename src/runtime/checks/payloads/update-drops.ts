/**
 * The fields an entity's update answers success to and does not store, as
 * `update.persists-submitted-fields` found them. Every check that writes a field picks around them,
 * so the one defect is reported once, by that check, never as a stale cache or a lost race.
 */

import type { CheckContext } from "../core/context.ts"
import { memoTable } from "../sets/read.ts"

const TABLE = "updateDrops"
const KEY = "fields"

/** What the update is known to drop on this entity; empty until the check has run. */
export function updateDrops(ctx: Pick<CheckContext, "memo">): ReadonlySet<string> {
	return new Set(memoTable<readonly string[]>(ctx.memo.entity, TABLE).get(KEY) ?? [])
}

export function recordUpdateDrops(ctx: Pick<CheckContext, "memo">, fields: readonly string[]): void {
	memoTable<readonly string[]>(ctx.memo.entity, TABLE).set(KEY, [...fields])
}
