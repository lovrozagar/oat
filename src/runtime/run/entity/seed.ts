import { resolvePathScope, SeedError } from "../../world.ts"
import { existingOrBlocked, readExisting, worldOptions } from "./fallback.ts"
import { seedCreated } from "./seed-cohort.ts"
import { degradedWorld, type EntityRun, type World } from "./state.ts"
import type { RunFindingId } from "../../check-ids.ts"

/** How the entity's records come to exist, in the order the cases are decided. */
export interface SeedPlan {
	/** No create to seed through: an invite-only entity has its grant, not a create. */
	inviteOnly: boolean
	/** The create is the principals' sign-up: it already ran in auth, and is no fixture. */
	authProvisioned: boolean
	/** A listable entity with no create whose action declares x-effects: its list needs a parent. */
	needsListedCohort: boolean
}

/**
 * The entity's world, or `null` when there is nothing to test it against (the reason already
 * reported). A scenario-owned create, an excluded create and a missing create all read what
 * exists; only a create oat may send seeds a cohort of its own.
 */
export async function seedWorld(run: EntityRun, plan: SeedPlan): Promise<World | null> {
	const { createOp, ctx, entity } = run
	if (createOp !== undefined && ctx.scenarioOwned.has(createOp.operationId)) {
		/* A scenario owns this create: it holds what the create needs (a mailed token, a paid
		 * session), and a generated body would only be refused. The matrix reads what exists;
		 * with nothing to read, the entity is the scenario's alone. */
		const existing = await readExisting(run, run.roots)
		return existing.records.length === 0 ? null : degradedWorld(existing)
	}
	if (createOp !== undefined && ctx.exclusion.excludeOp(entity, createOp)) {
		/* The gap finding excludeOp already reported names the reason. */
		return existingOrBlocked(run, {
			check: "profile.skip" satisfies RunFindingId,
			detail: `create is excluded by profile "${ctx.profile.name}" and the list route returned no existing records to fall back on.`,
			summary: `could not test "${entity.name}"`,
		})
	}
	if (createOp === undefined || plan.authProvisioned) return listedWorld(run, plan)
	return seedCreated(run, createOp)
}

/**
 * Invite is not a fixture create; register / x-fresh-principal already ran in auth. The invite
 * check is the only thing that POSTs a grant, and it uses inviteAs. The entity is read as listed,
 * under a parent oat makes when the list path names one the roots do not.
 */
async function listedWorld(run: EntityRun, plan: SeedPlan): Promise<World> {
	const listedRoots = await listedRootsOf(run, plan)
	const existing = await readExisting(run, listedRoots)
	return degradedWorld({ records: existing.records, scope: { ...run.roots, ...existing.scope } })
}

async function listedRootsOf(run: EntityRun, plan: SeedPlan): Promise<Record<string, string>> {
	const { listOp, roots, seeding, ctx } = run
	const listParent = async (): Promise<Record<string, string>> => ({
		...roots,
		...(await resolvePathScope(listOp, ctx.model, seeding, worldOptions(run))).values,
	})
	/* An action cohort has to create the parent the list path names. */
	if (plan.needsListedCohort) return listParent()
	if (plan.inviteOnly || listOp.pathParams.every((param) => roots[param] !== undefined)) return roots
	/* A table's exports, a webhook's deliveries: nobody creates one directly, but the list sits
	 * under a parent oat can make, and every check on the entity goes through it. A parent oat
	 * cannot make leaves the scope as it was, and the gap says which. */
	try {
		return await listParent()
	} catch (error) {
		if (!(error instanceof SeedError)) throw error
		return roots
	}
}
