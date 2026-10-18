/** One cohort's seeding as it goes: the records made so far, and how each create is sent and read. */

import type { OperationModel } from "../../spec/graph/types.ts"
import { encodeForOperation } from "../body.ts"
import type { Exchange } from "../exchange.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "../feature-gate.ts"
import type { CohortMember } from "../fixture.ts"
import { returnedId } from "../proven-id.ts"
import { SeedError } from "../seed-error.ts"
import { isUniqueConflictResponse, uniquifyProbeBody } from "../unique.ts"
import type { UploadContext } from "../upload.ts"
import { adoptExisting } from "./adopt.ts"
import { createdRecord } from "./created-record.ts"
import { isPlanLimitResponse } from "./plan-limit.ts"
import type { Record_ } from "./records.ts"
import type { Scope, SeededCohort, Seeding } from "./types.ts"

export interface CohortRun {
	createOp: OperationModel
	seeding: Seeding
	scope: Scope
	schema: Record<string, unknown>
	path: string
	/** The entity's identity, as its records carry it. */
	identity: string
	/** A client-chosen identity the create body names, or `null`. */
	ownIdentity: string | null
	records: Record_[]
	seededMembers: CohortMember[]
	failedVariants: Array<{ variant: string; exchange: Exchange }>
	acknowledged: boolean
	uniqueGap: string | undefined
	existingIds: string[]
	lastFail: { member: CohortMember; exchange: Exchange } | undefined
}

/** `null` for an acknowledgement oat could not confirm: it names no record, so it joins no cohort. */
export async function recordCreated(run: CohortRun, exchange: Exchange, sent: unknown): Promise<Record_ | null> {
	const { createOp, seeding, scope } = run
	const { model, client, options } = seeding
	/* A create's id is the one its answer names, or one a read under it confirms. A record
	 * with neither is not oat's to track or remove: it joins no cohort and is reported. */
	const made = await createdRecord({
		client,
		createOp,
		exchange,
		headers: options.authHeaders,
		model,
		scope: { ...options.roots, ...scope.values },
		sent,
		...(options.readable === undefined ? {} : { readable: options.readable }),
	})
	if (made === null) {
		options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
		return null
	}
	if (made.acknowledged) run.acknowledged = true
	const id = returnedId(made.record, run.identity)
	if (createOp.entity !== null && id !== undefined) options.onCreate?.(createOp.entity, id, { ...scope.values })
	return made.record
}

export async function postMember(run: CohortRun, member: CohortMember, nextUploads: UploadContext): Promise<Exchange> {
	const { createOp, seeding } = run
	const encoded = await encodeForOperation(
		createOp,
		seeding.model,
		member.body,
		nextUploads,
		member.variant,
		run.records.length,
	)
	return seeding.client.request("POST", run.path, {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		headers: seeding.options.authHeaders,
		operationId: createOp.operationId,
		...(nextUploads.fixture === undefined ? {} : { fixture: nextUploads.fixture.filename }),
	})
}

/* A client-chosen identity is unique across every tenant, and this principal lists only its own:
 * one another tenant holds comes back 409. That identity is drawn again, from its own schema,
 * a few times before the 409 is taken as the answer. */
export async function postFresh(
	run: CohortRun,
	member: CohortMember,
	nextUploads: UploadContext,
): Promise<{ exchange: Exchange; sent: CohortMember }> {
	const { ownIdentity } = run
	let sent = member
	let exchange = await postMember(run, sent, nextUploads)
	for (let attempt = 0; attempt < 3 && exchange.status === 409; attempt++) {
		if (ownIdentity === null || !Object.hasOwn(sent.body, ownIdentity)) break
		const token = `id${attempt}-${sent.variant}-${run.seeding.options.nonce ?? ""}`
		sent = { ...sent, body: uniquifyProbeBody(sent.body, [[ownIdentity]], run.schema, token) }
		exchange = await postMember(run, sent, nextUploads)
	}
	return { exchange, sent }
}

/** The cohort with what the run learned along the way: gaps, lost variants, acknowledgements, existing ids. */
export function withGap(run: CohortRun, cohort: SeededCohort): SeededCohort {
	return {
		...cohort,
		...(run.uniqueGap === undefined ? {} : { uniqueGap: run.uniqueGap }),
		...(run.failedVariants.length === 0 ? {} : { failedVariants: run.failedVariants }),
		...(run.acknowledged ? { acknowledged: run.acknowledged } : {}),
		...(run.existingIds.length === 0 ? {} : { existingIds: run.existingIds }),
	}
}

function seedRefused(run: CohortRun, member: CohortMember, exchange: Exchange): SeedError {
	const { createOp } = run
	return new SeedError(
		createOp.operationId,
		`seeding "${member.variant}" returned ${exchange.status}: ` + JSON.stringify(exchange.responseBody).slice(0, 300),
		exchange.status,
		createOp.operationId,
		exchange,
	)
}

/** What a refused create leaves: the cohort so far, a documented gate, an adopted row, or a seed error. */
export async function failOrAdopt(run: CohortRun, member: CohortMember, exchange: Exchange): Promise<SeededCohort> {
	const { createOp, seeding, scope, records, seededMembers } = run
	if (records.length > 0) return withGap(run, { featureGate: null, members: seededMembers, records })
	if (isDocumentedFeatureGateDenial(createOp, exchange.status, exchange.responseBody)) {
		return withGap(run, {
			featureGate: {
				detail: describeFeatureGate(createOp, exchange.responseBody),
				exchange,
				key: createOp.featureGate as string,
			},
			members: seededMembers,
			records,
		})
	}
	if (isUniqueConflictResponse(createOp, exchange.status)) {
		const adopted = await adoptExisting(createOp, seeding, scope)
		if (adopted !== null) {
			return withGap(run, { featureGate: null, members: seededMembers, records: [adopted], uniqueAdopted: true })
		}
		throw seedRefused(run, member, exchange)
	}
	if (isPlanLimitResponse(exchange.status, exchange.responseBody)) {
		const adopted = await adoptExisting(createOp, seeding, scope)
		if (adopted !== null)
			return withGap(run, { adopted: true, featureGate: null, members: seededMembers, records: [adopted] })
	}
	throw seedRefused(run, member, exchange)
}
