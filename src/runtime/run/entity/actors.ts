import type { Actor } from "../../checks/core/context.ts"
import { resolvePathScope } from "../../world/path-scope.ts"
import type { RunPrincipal } from "../context.ts"
import type { EntityRun, World } from "./state.ts"

/** Every principal as the entity's checks act as it: the first in the world, the rest each in theirs. */
export async function actorsOf(run: EntityRun, world: World): Promise<[Actor, ...Actor[]]> {
	const { principals } = run.ctx
	const actors: [Actor, ...Actor[]] = [actor(principals.alpha, world.scope.values)]
	for (const [index, principal] of principals.all.slice(1).entries()) {
		actors.push(await scopedActor(run, principal, index + 1))
	}
	return actors
}

/** The first actor of a tenant other than the first's: what the isolation checks read and write across. */
export function peerOf(actors: readonly [Actor, ...Actor[]]): Actor | undefined {
	return actors.find((candidate) => candidate.tenant !== actors[0].tenant)
}

/**
 * A principal in a scope of its own: the parents the list path names, created as this principal
 * so they are removed as it. A principal that cannot make them acts within its own scope alone.
 */
async function scopedActor(run: EntityRun, principal: RunPrincipal, offset: number): Promise<Actor> {
	const { ctx, listOp, seeding, ancestors } = run
	const { principals, exclusion, nonce, seed, uploads } = ctx
	const roots = { ...principal.scope }
	try {
		const next = await resolvePathScope(listOp, {
			client: seeding,
			model: ctx.model,
			options: {
				ancestors,
				/* Its own nonce: its parents must not share the first principal's names, or a server
				 * deriving a key from them gives both tenants the same one. */
				nonce: `${nonce}-${offset}`,
				onCreate: principals.recorder(principals.ownerOf(principal)),
				onUnidentified: principals.unidentified,
				principal: principal.id,
				readable: exclusion.readable,
				roots,
				seed: seed + offset,
				uploads: { ...uploads, seed: seed + offset },
			},
		})
		return actor(principal, { ...roots, ...next.values })
	} catch {
		return actor(principal, roots)
	}
}

function actor(principal: RunPrincipal, scope: Record<string, string>): Actor {
	return { id: principal.id, inviteAs: principal.inviteAs, rank: principal.rank, scope, tenant: principal.tenant }
}
