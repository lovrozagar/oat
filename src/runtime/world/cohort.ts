/** One cohort's seeding as it goes: the records made so far, and how each create is sent and read. */

import type { OperationModel } from "../../spec/graph/types.ts"
import { encodeForOperation } from "../body/encode.ts"
import type { Exchange } from "../exchange.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "../feature-gate.ts"
import type { CohortMember } from "../fixture.ts"
import { returnedId } from "../proven-id.ts"
import { SeedError } from "../seed-error.ts"
import { isUniqueConflictResponse } from "../unique.ts"
import type { UploadContext } from "../upload.ts"
import { adoptExisting } from "./adopt.ts"
import { createWithClientId, takenFor } from "./client-identity.ts"
import { createdRecord } from "./created-record.ts"
import { isPlanLimitResponse } from "./plan-limit.ts"
import type { Record_ } from "./records.ts"
import type { Scope, SeededCohort, Seeding } from "./types.ts"
import type { JsonSchema } from "../../spec/types.ts"

export interface CohortRun {
	createOp: OperationModel
	seeding: Seeding
	scope: Scope
	schema: JsonSchema
	path: string
	/** The entity's identity, as its records carry it. */
	identity: string
	/** A client-chosen identity the create body names, or `null`. */
	ownIdentity: string | null
	records: Record_[]
	seededMembers: CohortMember[]
	failedVariants: Array<{ variant: string; exchange: Exchange }>
	acknowledged: boolean
	/** Why the first record that is the body oat sent was not read back (`readBackCreated`). */
	unverified: string | undefined
	uniqueGap: string | undefined
	existingIds: string[]
	lastFail: { member: CohortMember; exchange: Exchange } | undefined
}

/** `null` for an acknowledgment oat could not confirm: it names no record, so it joins no cohort. */
export async function recordCreated(run: CohortRun, exchange: Exchange, sent: unknown): Promise<Record_ | null> {
	const { createOp, seeding, scope } = run
	const { model, client, options } = seeding
	/* A create's id is the one its answer names, or one a read under it confirms. A record
	 * with neither is not oat's to track or remove: it joins no cohort and is reported. */
	const made = await createdRecord({
		client,
		createOp,
		exchange,
		model,
		principal: options.principal,
		scope: { ...options.roots, ...scope.values },
		sent,
		...(options.readable === undefined ? {} : { readable: options.readable }),
	})
	if (made === null) {
		options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
		return null
	}
	if (made.acknowledged) run.acknowledged = true
	if (made.unverified !== undefined) run.unverified ??= made.unverified
	const id = returnedId(made.record, run.identity)
	if (createOp.entity !== null && id !== undefined) options.onCreate?.(createOp.entity, id, { ...scope.values })
	return made.record
}

export async function postMember(run: CohortRun, member: CohortMember, nextUploads: UploadContext): Promise<Exchange> {
	const { createOp, seeding } = run
	const encoded = await encodeForOperation(createOp, seeding.model, {
		fields: member.body,
		index: run.records.length,
		uploads: nextUploads,
		variant: member.variant,
	})
	return seeding.client.request("POST", run.path, {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		as: { principal: seeding.options.principal },
		operationId: createOp.operationId,
		...(nextUploads.fixture === undefined ? {} : { fixture: nextUploads.fixture.filename }),
	})
}

/*
 * A client-chosen identity is unique across every tenant, and this principal lists only its own:
 * one another tenant holds comes back 409. It is sent again under a fresh one (`createWithClientId`),
 * and `exhausted` says why when the last attempt was refused too.
 */
export async function postFresh(
	run: CohortRun,
	member: CohortMember,
	nextUploads: UploadContext,
): Promise<{ exchange: Exchange; sent: CohortMember; exhausted?: string }> {
	const { createOp, ownIdentity, schema, seeding } = run
	const { options } = seeding
	const made = await createWithClientId(member.body, (body) => postMember(run, { ...member, body }, nextUploads), {
		identity: ownIdentity,
		schema,
		taken: takenFor(options, createOp),
		token: `id-${member.variant}-${options.nonce ?? ""}`,
	})
	const sent = made.sent === member.body ? member : { ...member, body: made.sent }
	return { exchange: made.exchange, sent, ...(made.exhausted === undefined ? {} : { exhausted: made.exhausted }) }
}

/** The cohort with what the run learned along the way: gaps, lost variants, acknowledgments, unverified records, existing ids. */
export function withGap(run: CohortRun, cohort: SeededCohort): SeededCohort {
	return {
		...cohort,
		...(run.uniqueGap === undefined ? {} : { uniqueGap: run.uniqueGap }),
		...(run.failedVariants.length === 0 ? {} : { failedVariants: run.failedVariants }),
		...(run.acknowledged ? { acknowledged: run.acknowledged } : {}),
		...(run.unverified === undefined ? {} : { unverified: run.unverified }),
		...(run.existingIds.length === 0 ? {} : { existingIds: run.existingIds }),
	}
}

function seedRefused(run: CohortRun, member: CohortMember, exchange: Exchange): SeedError {
	const { createOp } = run
	return new SeedError(
		createOp.operationId,
		`seeding "${member.variant}" returned ${exchange.status}: ` + JSON.stringify(exchange.responseBody).slice(0, 300),
		{ exchange, operationId: createOp.operationId, status: exchange.status },
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
