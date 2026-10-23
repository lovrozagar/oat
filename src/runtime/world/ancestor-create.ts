import type { OperationModel } from "../../spec/graph/types.ts"
import { encodeForOperation } from "../body/encode.ts"
import { type CohortMember, buildCohort, overflowFrom } from "../fixture.ts"
import { fillPath } from "../fill-path.ts"
import { SeedError } from "../seed-error.ts"
import { isUniqueConflictResponse, uniquifyProbeBody } from "../unique.ts"
import type { Exchange } from "../exchange.ts"
import { adoptExisting } from "./adopt.ts"
import {
	bodyIdentity,
	type ClientIdCreate,
	createWithClientId,
	identitiesRefused,
	takenFor,
} from "./client-identity.ts"
import { createdRecord } from "./created-record.ts"
import { isPlanLimitResponse } from "./plan-limit.ts"
import type { Record_ } from "./records.ts"
import { requestSchemaOf, stringProperties } from "./schema.ts"
import type { Scope, Seeding } from "./types.ts"
import { uploadContext } from "./upload-context.ts"

/** The body an ancestor create sends, and the cohort member it came from. */
function ancestorBody(
	createOp: OperationModel,
	seeding: Seeding,
): { body: Record<string, unknown>; member: CohortMember } {
	const { model, options } = seeding
	const schema = requestSchemaOf(createOp, model)
	let member: CohortMember
	try {
		/* One variant asked for, one member made: buildCohort maps the variants it is given. */
		member = buildCohort(schema ?? {}, options.seed, {
			variants: ["baseline"],
			defs: model.defs,
			/* A parent made as scaffolding carries the nonce in every string, not only the unique ones:
			 * a server that derives an undeclared key from a name (a slug) must never see the name the
			 * entity's own cohort, another tenant's parent, existing data or a later run takes. */
			distinct: new Set([...(createOp.unique ?? []).flat(), ...stringProperties(schema)]),
			...(options.nonce === undefined ? {} : { nonce: options.nonce }),
			operationId: createOp.operationId,
		})[0] as CohortMember
	} catch (error) {
		/* buildCohort reports every failure as an overflow; it is named after this operation. */
		throw overflowFrom(error, createOp.operationId)
	}
	let body = member.body
	const unique = createOp.unique ?? []
	if (unique.length > 0) {
		/* Ancestor creates share the entity seed with the entity's own cohort; unique columns
		 * must not collide with a later seed of the same collection. */
		body = uniquifyProbeBody(body, unique, { schema, token: `anc${options.seed}-${options.nonce ?? ""}` })
	}
	return { body, member }
}

/* Sends one ancestor body to the create, as the seeding principal. */
async function post(
	createOp: OperationModel,
	{ seeding, scope }: { seeding: Seeding; scope: Scope },
	{ body, member }: { body: Record<string, unknown>; member: CohortMember },
): Promise<Exchange> {
	const { model, client, options } = seeding
	const encoded = await encodeForOperation(createOp, model, {
		fields: body,
		index: 0,
		uploads: uploadContext(options),
		variant: member.variant,
	})
	return client.request("POST", fillPath(createOp.path, scope.values), {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		as: { principal: options.principal },
		operationId: createOp.operationId,
	})
}

/*
 * The ancestor's create, sent through `createWithClientId`: a body naming its own identity is sent
 * again under a fresh one when another record holds it.
 */
function postFresh(createOp: OperationModel, seeding: Seeding, scope: Scope): Promise<ClientIdCreate> {
	const { model, options } = seeding
	const drawn = ancestorBody(createOp, seeding)
	const schema = requestSchemaOf(createOp, model) ?? {}
	return createWithClientId(
		drawn.body,
		(fields) => post(createOp, { scope, seeding }, { body: fields, member: drawn.member }),
		{
			identity: bodyIdentity(model, createOp, schema),
			schema,
			taken: takenFor(options, createOp),
			token: `anc${options.seed}-${options.nonce ?? ""}`,
		},
	)
}

/*
 * A refused create: a listed row adopted under a plan limit or a unique conflict, else the refusal.
 * Identities refused every time adopt nothing: the seed fails, saying so.
 */
async function adoptOrFail(
	createOp: OperationModel,
	{ scope, seeding }: { scope: Scope; seeding: Seeding },
	{ exchange, exhausted }: ClientIdCreate,
): Promise<{ record: Record_; adopted: boolean }> {
	if (exhausted !== undefined) throw identitiesRefused(createOp.operationId, exchange, exhausted)
	/* Plan limit after an effect (or a sibling create) already filled the quota: reuse a
	 * same-tenant row from the list. Do not invent an id. */
	if (isPlanLimitResponse(exchange.status, exchange.responseBody)) {
		const reused = await adoptExisting(createOp, seeding, scope)
		if (reused !== null) return { adopted: true, record: reused }
	}
	if (isUniqueConflictResponse(createOp, exchange.status)) {
		const reused = await adoptExisting(createOp, seeding, scope)
		if (reused !== null) return { adopted: true, record: reused }
	}
	throw new SeedError(
		createOp.operationId,
		`${createOp.operationId} returned ${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 300)}`,
		{ exchange, operationId: createOp.operationId, status: exchange.status },
	)
}

/**
 * Creates one ancestor record, or adopts a listed one when the create is refused for a limit or a
 * conflict. A body naming its own identity is sent again under a fresh one when another record holds
 * it, and adopts nothing: after the last refusal, the seed fails with why.
 */
export async function createOne(
	createOp: OperationModel,
	seeding: Seeding,
	scope: Scope,
): Promise<{ record: Record_; adopted: boolean }> {
	const { model, client, options } = seeding
	const withheld = options.withheld?.(createOp)
	if (withheld !== undefined) throw new SeedError(createOp.operationId, withheld)
	const created = await postFresh(createOp, seeding, scope)
	const { exchange, sent } = created
	if (exchange.status >= 300) return adoptOrFail(createOp, { scope, seeding }, created)
	const made = await createdRecord({
		client,
		createOp,
		exchange,
		model,
		principal: options.principal,
		scope: { ...options.roots, ...scope.values },
		sent,
		wants: "id",
		...(options.readable === undefined ? {} : { readable: options.readable }),
	})
	if (made !== null) return { adopted: false, record: made.record }
	/* Made, but by no id oat can read: the caller cannot use it, and teardown cannot remove it. */
	options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
	return { adopted: false, record: {} }
}
