import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import {
	type CohortMember,
	buildCohort,
	ensureDistinctUniqueValues,
	isOverflowError,
	overflowFrom,
} from "../fixture.ts"
import { fillPath } from "../fill-path.ts"
import { SeedError } from "../seed-error.ts"
import { uniqueTupleCollides, uniquifyProbeBody } from "../unique.ts"
import type { UploadContext } from "../upload.ts"
import { forEachInvocation } from "../upload-each.ts"
import { type CohortRun, failOrAdopt, postFresh, postMember, recordCreated, withGap } from "./cohort.ts"
import { listExisting } from "./list-existing.ts"
import { isScalarId, type Record_ } from "./records.ts"
import { requestSchemaOf } from "./schema.ts"
import type { Scope, SeededCohort, Seeding } from "./types.ts"
import { uploadContext } from "./upload-context.ts"

/** What a cohort is generated against: the body schema, the identity, and the unique sets to keep apart. */
interface CohortPlan {
	schema: Record<string, unknown>
	identity: string
	ownIdentity: string | null
	/** The create body names its own identity, and no declared unique set covers it alone. */
	identityInBody: boolean
	/** Unique sets no generated body may share with an existing record. */
	avoid: string[][]
}

function cohortPlan(createOp: OperationModel, model: SpecModel): CohortPlan {
	const schema = requestSchemaOf(createOp, model)
	if (schema === null) {
		throw new SeedError(createOp.operationId, `${createOp.operationId} declares no request body`)
	}
	const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
	/* A client-chosen identity names one record by definition: never generate one an existing record
	 * holds. Generation only — the identity does not join the unique sets checks grade. */
	const ownIdentity = entity?.identity ?? null
	const bodyProperties = (schema.properties ?? {}) as Record<string, unknown>
	const identityInBody =
		ownIdentity !== null &&
		Object.hasOwn(bodyProperties, ownIdentity) &&
		!(createOp.unique ?? []).some((set) => set.length === 1 && set[0] === ownIdentity)
	const avoid: string[][] =
		identityInBody && ownIdentity !== null ? [...(createOp.unique ?? []), [ownIdentity]] : (createOp.unique ?? [])
	return { avoid, identity: entity?.identity ?? "id", identityInBody, ownIdentity, schema }
}

function plannedMembers(
	createOp: OperationModel,
	seeding: Seeding,
	plan: CohortPlan,
): { members: CohortMember[]; gap: string | null } {
	const { model, options } = seeding
	const generated = buildCohort(plan.schema, options.seed, {
		defs: model.defs,
		distinct: new Set(plan.avoid.flat()),
		...(options.nonce === undefined ? {} : { nonce: options.nonce }),
		operationId: createOp.operationId,
	}).slice(0, options.cohortSize ?? 7)
	return ensureDistinctUniqueValues(generated, createOp.unique ?? [], {
		schema: plan.schema,
		defs: model.defs,
		distinct: new Set((createOp.unique ?? []).flat()),
		...(options.nonce === undefined ? {} : { nonce: options.nonce }),
	})
}

/** The members redrawn until none shares a unique set with a listed record; none may name a listed identity. */
function avoidExisting(
	input: { createOp: OperationModel; plan: CohortPlan; nonce: string | undefined },
	members: CohortMember[],
	existing: Record_[],
): CohortMember[] {
	const { createOp, plan } = input
	const { avoid, ownIdentity } = plan
	let kept = members.map((member, index) => {
		let body = member.body
		for (let token = 0; token < 8 && uniqueTupleCollides(body, avoid, existing); token++) {
			body = uniquifyProbeBody(body, avoid, { schema: plan.schema, token: `ex${index}${token}-${input.nonce ?? ""}` })
		}
		return { ...member, body }
	})
	/* A body still naming an existing record's identity would overwrite or adopt it: never send it. */
	if (plan.identityInBody && ownIdentity !== null) {
		kept = kept.filter((member) => !uniqueTupleCollides(member.body, [[ownIdentity]], existing))
		if (kept.length === 0) {
			throw new SeedError(
				createOp.operationId,
				`every generated "${ownIdentity}" names an existing record, so nothing was created`,
			)
		}
	}
	return kept
}

/** One create per fixture slot, from the baseline member. */
async function seedSlot(run: CohortRun, members: CohortMember[], nextUploads: UploadContext): Promise<null> {
	const [baseline] = members
	const member = baseline ?? { body: {}, variant: "baseline" as const }
	const exchange = await postMember(run, member, nextUploads)
	if (exchange.status >= 300) {
		run.lastFail = { exchange, member }
		return null
	}
	const record = await recordCreated(run, exchange, member.body)
	if (record === null) return null
	run.seededMembers.push(member)
	run.records.push(record)
	return null
}

/** Every planned member in turn; the first create decides whether there is a cohort at all. */
async function seedPlanned(
	run: CohortRun,
	members: CohortMember[],
	nextUploads: UploadContext,
): Promise<SeededCohort | null> {
	for (const planned of members) {
		const { exchange, sent: member } = await postFresh(run, planned, nextUploads)
		if (exchange.status >= 300) {
			/* The first create decides whether there is a cohort at all; a later one failing
			 * is a variant lost, reported rather than ending the cohort in silence. */
			if (run.records.length === 0) return failOrAdopt(run, member, exchange)
			run.failedVariants.push({ exchange, variant: member.variant })
			continue
		}
		const record = await recordCreated(run, exchange, member.body)
		/* Acknowledged but never confirmed: no record to stand for, so no member either. */
		if (record === null) continue
		run.seededMembers.push(member)
		run.records.push(record)
	}
	return null
}

/** The cohort's seeding state before its first create. */
function cohortRun(start: {
	createOp: OperationModel
	seeding: Seeding
	scope: Scope
	plan: CohortPlan
	existingIds: string[]
	uniqueGap: string | undefined
}): CohortRun {
	const { createOp, plan, scope } = start
	return {
		acknowledged: false,
		createOp,
		existingIds: start.existingIds,
		failedVariants: [],
		identity: plan.identity,
		lastFail: undefined,
		ownIdentity: plan.ownIdentity,
		path: fillPath(createOp.path, scope.values),
		records: [],
		schema: plan.schema,
		scope,
		seededMembers: [],
		seeding: start.seeding,
		uniqueGap: start.uniqueGap,
	}
}

/** Creates the cohort and returns the server's view of each instance. */
export async function seedCohort(createOp: OperationModel, seeding: Seeding, scope: Scope): Promise<SeededCohort> {
	const { model, client, options } = seeding
	const plan = cohortPlan(createOp, model)
	let members: CohortMember[]
	let uniqueGap: string | undefined
	let existingIds: string[]
	try {
		const distinct = plannedMembers(createOp, seeding, plan)
		members = distinct.members
		if (distinct.gap !== null) uniqueGap = distinct.gap
		const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
		const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
		const existing =
			listOp === undefined
				? []
				: await listExisting(
						{ listOp, model, values: { ...options.roots, ...scope.values } },
						client,
						options.principal,
					)
		const { ownIdentity } = plan
		existingIds =
			ownIdentity === null
				? []
				: existing
						.map((row) => row[ownIdentity])
						.filter(isScalarId)
						.map(String)
		if (existing.length > 0 && plan.avoid.length > 0) {
			members = avoidExisting({ createOp, nonce: options.nonce, plan }, members, existing)
		}
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	const run = cohortRun({ createOp, existingIds, plan, scope, seeding, uniqueGap })
	const outcomes = await forEachInvocation<SeededCohort | null>(
		createOp.operationId,
		uploadContext(options),
		(nextUploads, slot) =>
			slot === undefined ? seedPlanned(run, members, nextUploads) : seedSlot(run, members, nextUploads),
	)
	const early = outcomes.find((outcome) => outcome !== null)
	if (early !== undefined) return early
	if (run.records.length === 0 && run.lastFail !== undefined) {
		/* A refusal always answers with a cohort or a seed error. */
		const failed = await failOrAdopt(run, run.lastFail.member, run.lastFail.exchange)
		return failed
	}
	return withGap(run, {
		featureGate: null,
		members: run.seededMembers.length > 0 ? run.seededMembers : members,
		records: run.records,
	})
}
