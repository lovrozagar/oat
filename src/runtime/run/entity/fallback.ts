import type { Exchange } from "../../exchange.ts"
import { listExisting } from "../../world/list-existing.ts"
import { type Record_ } from "../../world/records.ts"
import { type WorldOptions } from "../../world/types.ts"
import { takenOf } from "../state.ts"
import { degradedWorld, type EntityRun, type World } from "./state.ts"

/** How the first principal builds this entity's world: its credential, its records, its parents. */
export function worldOptions(run: EntityRun): WorldOptions {
	const { ctx, ancestors, roots } = run
	const { principals, exclusion, nonce, seed, state, uploads } = ctx
	return {
		ancestors,
		nonce,
		onCreate: principals.recorder(principals.ownerOf(principals.alpha)),
		onUnidentified: principals.unidentified,
		principal: principals.alpha.id,
		readable: exclusion.readable,
		roots,
		seed,
		taken: (entity) => takenOf(state, entity),
		uploads,
	}
}

/** Reads whatever the list endpoint already returns, for degraded read-only coverage. */
export async function readExisting(
	run: EntityRun,
	roots: Record<string, string>,
): Promise<{ records: Record_[]; scope: Record<string, string> }> {
	/* Seed with every known root, not only the list route's own parameters. Sibling routes for
	 * the same entity are often scoped differently — a global list beside a tenant-scoped item
	 * route — and a scope built from the list alone leaves those unresolvable. */
	const scope: Record<string, string> = { ...roots }
	if (run.listOp.pathParams.some((param) => scope[param] === undefined)) return { records: [], scope }
	const { model, principals } = run.ctx
	const records = await listExisting({ listOp: run.listOp, model, values: scope }, run.seeding, principals.alpha.id)
	return { records, scope }
}

/** Why an entity could not be tested at all, when nothing already exists to fall back on. */
export interface Blocked {
	check: string
	summary: string
	detail: string
	evidence?: Exchange[]
}

/**
 * Read-only coverage against whatever already exists beats no coverage: it is exactly the state
 * most likely to hide a read-path bug. With nothing to read, the entity is blocked, and `blocked`
 * says why. `null` when it is.
 */
export async function existingOrBlocked(run: EntityRun, blocked: Blocked): Promise<World | null> {
	const existing = await readExisting(run, run.roots)
	if (existing.records.length > 0) return degradedWorld(existing)
	run.findings.blocked(blocked.check, run.entity.name, {
		summary: blocked.summary,
		cause: blocked.detail,
		evidence: blocked.evidence,
	})
	return null
}
