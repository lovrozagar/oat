import type { OperationModel } from "../../spec/graph/types.ts"
import { encodeForOperation } from "../body/encode.ts"
import { type CohortMember, buildCohort, overflowFrom } from "../fixture.ts"
import { fillPath } from "../fill-path.ts"
import { SeedError } from "../seed-error.ts"
import { isUniqueConflictResponse, uniquifyProbeBody } from "../unique.ts"
import { adoptExisting } from "./adopt.ts"
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

/** Creates one ancestor record, or adopts a listed one when the create is refused for a limit or a conflict. */
export async function createOne(
	createOp: OperationModel,
	seeding: Seeding,
	scope: Scope,
): Promise<{ record: Record_; adopted: boolean }> {
	const { model, client, options } = seeding
	const { body, member } = ancestorBody(createOp, seeding)
	const encoded = await encodeForOperation(createOp, model, {
		fields: body,
		index: 0,
		uploads: uploadContext(options),
		variant: member.variant,
	})
	const exchange = await client.request("POST", fillPath(createOp.path, scope.values), {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		as: { principal: options.principal },
		operationId: createOp.operationId,
	})
	if (exchange.status >= 300) {
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
	const made = await createdRecord({
		client,
		createOp,
		exchange,
		model,
		principal: options.principal,
		scope: { ...options.roots, ...scope.values },
		sent: body,
		...(options.readable === undefined ? {} : { readable: options.readable }),
	})
	if (made !== null) return { adopted: false, record: made.record }
	/* Made, but by no id oat can read: the caller cannot use it, and teardown cannot remove it. */
	options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
	return { adopted: false, record: {} }
}
