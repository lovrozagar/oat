import type { OperationModel } from "../../../spec/graph/types.ts"
import { formatUniqueSets } from "../../../spec/extensions/unique.ts"
import { resolvePathScope } from "../../world/path-scope.ts"
import { type Scope, type SeededCohort } from "../../world/types.ts"
import { seedCohort } from "../../world/seed-cohort.ts"
import { ids } from "../../checks/sets/list.ts"
import { existingOrBlocked, worldOptions } from "./fallback.ts"
import { seedFailed } from "./seed-failure.ts"
import type { EntityRun, World } from "./state.ts"
import type { RunFindingId } from "../../check-ids.ts"

/**
 * Seeds the entity through its create: the parents its path names, then a cohort of records.
 * Every ancestor and cohort record is ledgered as it is created, in creation order — the unwind
 * reverses it, so children go before their parents.
 */
export async function seedCreated(run: EntityRun, createOp: OperationModel): Promise<World | null> {
	const { ctx, seeding, roots } = run
	try {
		const scope = await resolvePathScope(createOp, { client: seeding, model: ctx.model, options: worldOptions(run) })
		/* Carry every known root, not only what the create route happened to need. Sibling routes
		 * for one entity are frequently scoped differently — a global create beside a tenant-scoped
		 * item route — and a scope built from create alone leaves those unresolvable, which shows
		 * up as a wall of "could not complete" gaps. */
		scope.values = { ...roots, ...scope.values }
		const options = ctx.options.cohortSize === undefined ? {} : { cohortSize: ctx.options.cohortSize }
		const cohort = await seedCohort(
			createOp,
			{ client: seeding, model: ctx.model, options: { ...worldOptions(run), ...options } },
			scope,
		)
		reportVariants(run, createOp, cohort)
		return await worldOf(run, createOp, cohort, scope)
	} catch (error) {
		return seedFailed(run, createOp, error)
	}
}

/** What the cohort's seeding said about variants that could not be created. */
function reportVariants(run: EntityRun, createOp: OperationModel, cohort: SeededCohort): void {
	const { entity, findings } = run
	if (cohort.uniqueGap !== undefined)
		findings.gap("world.seed" satisfies RunFindingId, entity.name, {
			summary: cohort.uniqueGap,
			detail: cohort.uniqueGap,
		})
	run.lostVariants = (cohort.failedVariants ?? []).map((failed) => failed.variant)
	for (const failed of cohort.failedVariants ?? []) {
		const said = JSON.stringify(failed.exchange.responseBody).slice(0, 300)
		if (failed.exchange.status >= 500) {
			findings.backend("create.does-not-error" satisfies RunFindingId, entity.name, {
				summary: `creating the "${failed.variant}" variant of a "${entity.name}" fails with a server error`,
				detail:
					`${createOp.operationId} returned ${failed.exchange.status} for a body generated from the ` +
					`documented schema (${said}). The other variants were created, so this input is what ` +
					"breaks the handler. Checks that need this variant's data run without it.",
				evidence: [failed.exchange],
			})
			continue
		}
		findings.gap("world.seed" satisfies RunFindingId, entity.name, {
			summary: `the "${failed.variant}" variant of "${entity.name}" was refused with ${failed.exchange.status}`,
			detail:
				`${createOp.operationId} refused a body the document permits (${said}). Checks that ` +
				"rely on this variant's values run without them.",
		})
	}
}

/** The world a seeded cohort leaves: oat's own records, or ones it adopted or had to read. */
async function worldOf(
	run: EntityRun,
	createOp: OperationModel,
	cohort: SeededCohort,
	scope: Scope,
): Promise<World | null> {
	const { entity, findings } = run
	if (cohort.adopted === true) {
		/* Plan limit after an effect already created the row: keep the id so children (row after
		 * extract→table) can seed, but do not assert write-path oracles against a body oat never
		 * submitted. Adopted, not created: this record is somebody else's to keep. */
		findings.gap("world.seed" satisfies RunFindingId, entity.name, {
			summary: `seeding "${entity.name}" hit a plan limit; using an existing same-tenant record`,
			detail:
				`${createOp.operationId} returned a plan-limit refusal and the list already ` +
				"had a record — likely an earlier x-effects create. Write-path checks stand " +
				"down rather than treat payment_required as a backend defect.",
		})
		return { ...owned(run, cohort, scope), degraded: true }
	}
	if (cohort.uniqueAdopted === true) {
		/* Unique 409 on the first variant with a same-tenant list: adopt like 402, but
		 * unique-conflict checks still run against that row. The seed 409 is not the unique check
		 * passing — that check is the explicit second POST. */
		findings.gap("world.seed" satisfies RunFindingId, entity.name, {
			summary: `seeding "${entity.name}" could not insert because of x-unique`,
			detail:
				`${createOp.operationId} returned 409 and the list already had a record. ` +
				`x-unique: ${formatUniqueSets(createOp.unique)}. The create could not insert; ` +
				"unique-conflict checks still run against that row. Write-path oracles that " +
				"need a body oat submitted stand down.",
		})
		return { ...owned(run, cohort, scope), degraded: true, uniqueAdopted: true }
	}
	if (cohort.featureGate !== null) return gatedWorld(run, cohort.featureGate.detail)
	return { ...owned(run, cohort, scope), createAcknowledged: cohort.acknowledged === true }
}

/* The cohort's records, and every identity the collection is known to hold. */
function owned(run: EntityRun, cohort: SeededCohort, scope: Scope): World {
	for (const id of cohort.existingIds ?? []) run.taken.add(id)
	/* An entity nothing identifies has no identities to take. */
	const identity = run.entity.identity
	if (identity !== null) for (const id of ids(cohort.records, identity)) run.taken.add(id)
	return { createAcknowledged: false, degraded: false, records: cohort.records, scope, uniqueAdopted: false }
}

/**
 * Same degradation a profile-excluded create takes: the tag said this principal cannot create the
 * row, so a correct 403 is coverage, not a seed defect. schema.error-response-matches-document
 * still judges its body.
 */
function gatedWorld(run: EntityRun, detail: string): Promise<World | null> {
	run.findings.gap("world.seed" satisfies RunFindingId, run.entity.name, {
		summary: `seeding "${run.entity.name}" is gated by ${detail}`,
		detail: `${detail}. Checks that need a row oat created stand down rather than treat the documented 403 as a defect.`,
	})
	return existingOrBlocked(run, {
		check: "world.seed" satisfies RunFindingId,
		detail: `${detail} and the list route returned no existing records to fall back on.`,
		summary: `could not test "${run.entity.name}"`,
	})
}
