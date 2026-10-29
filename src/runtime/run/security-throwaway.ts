/*
 * A DELETE probe's target: a throwaway record of its own, never one another step uses. A refusal
 * probe's DELETE that a broken API applies takes its record with it, and a shared record's children
 * after it, so each DELETE operation gets a record made for it alone: by its entity's create, as the
 * creator of the record a write probe would target, in that record's scope, with no children. It is
 * ledgered like any create and removed by teardown; one a probe's DELETE consumed is already gone.
 */

import type { Probed, WriteTarget } from "../checks/core/operation-context.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { messageOf } from "../../errors/message.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { encodeForOperation } from "../body/encode.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { fillPath } from "../fill-path.ts"
import type { Disposable } from "../teardown/types.ts"
import type { Exchange } from "../exchange.ts"
import { uniquifyProbeBody } from "../unique.ts"
import { bodyIdentity, createWithClientId, reserveIdentity } from "../world/client-identity.ts"
import { requestSchemaOf, stringProperties } from "../world/schema.ts"
import type { RunContext } from "./context.ts"
import { targetOf, targetRecord } from "./security-target.ts"
import { takenOf } from "./state.ts"

/** The write stage's throwaways: each DELETE operation's current one, and how many were made. */
export interface Throwaways {
	held: Map<string, WriteTarget>
	made: number
}

/** Throwaways for one write stage: none yet. */
export function throwaways(): Throwaways {
	return { held: new Map(), made: 0 }
}

/** Whether `op` removes a record: its probes take a throwaway target. */
export function isDelete(op: OperationModel): boolean {
	return op.method.toUpperCase() === "DELETE"
}

/**
 * The throwaway `op`'s next probe sends to: the one it holds, else a new one. Untested, with the
 * reason, when the run created no record `op` names to model it on, its entity has no create, or the
 * create made nothing oat could ledger.
 */
export async function throwawayTarget(
	ctx: RunContext,
	op: OperationModel,
	throwaway: Throwaways,
): Promise<Probed<WriteTarget>> {
	const kept = throwaway.held.get(op.operationId)
	if (kept !== undefined) return kept
	const shared = targetRecord(ctx, op)
	if (shared === undefined) return { untested: `a record this run created that ${op.operationId} can be sent to` }
	const { entity } = shared
	const createOp = ctx.model.byOperationId.get(ctx.model.entities.get(entity)?.create ?? "")
	if (createOp === undefined) {
		return { untested: `a create for ${entity}, to make a throwaway record that ${op.operationId} can remove` }
	}
	throwaway.made += 1
	const made = await create(ctx, { createOp, label: `t${throwaway.made}`, op, shared })
	if ("untested" in made) return { ...made, untested: `a throwaway ${entity} for ${op.operationId}: ${made.untested}` }
	const target = await targetOf(ctx, op, made)
	if (!("untested" in target)) throwaway.held.set(op.operationId, target)
	return target
}

/**
 * Drops `op`'s throwaway when a DELETE sent to it since the `since`th exchange went through: the
 * probe consumed it, and the next probe on `op` makes another.
 */
export function settle(ctx: RunContext, throwaway: Throwaways, at: { op: OperationModel; since: number }): void {
	const target = throwaway.held.get(at.op.operationId)
	if (target === undefined) return
	const { client } = ctx
	const consumed = client.transcript
		.slice(at.since)
		.some(
			(exchange) =>
				`${exchange.method} ${client.relativePath(exchange.url)}` === `DELETE ${target.path}` &&
				exchange.status >= 200 &&
				exchange.status < 300,
		)
	if (consumed) throwaway.held.delete(at.op.operationId)
}

/** What one throwaway is made from: the create, its label, the DELETE it is for, and the record it copies. */
interface Making {
	createOp: OperationModel
	label: string
	op: OperationModel
	shared: Disposable
}

/*
 * One record of the shared record's entity, made by `createOp` as its creator in its scope, and the
 * ledger's entry for it, one `op` names: the tracker ledgers it as the answer arrives. A client-chosen
 * identity is reserved as a check's create reserves one, and drawn again when another tenant's record
 * holds it (`createWithClientId`). Untested with the answer, the refused identities, or the error,
 * when there is none.
 */
async function create(ctx: RunContext, { createOp, label, op, shared }: Making): Promise<Probed<Disposable>> {
	const before = ctx.ledger.entries().length
	try {
		const schema = requestSchemaOf(createOp, ctx.model) ?? {}
		const at = {
			identity: bodyIdentity(ctx.model, createOp, schema),
			schema,
			taken: takenOf(ctx.state, shared.entity),
			token: `i${label}`,
		}
		const send = async (fields: Record<string, unknown>): Promise<Exchange> => {
			const encoded = await encodeForOperation(createOp, ctx.model, { fields, uploads: ctx.uploads })
			return ctx.client
				.view({ purpose: "probe", subject: createOp.operationId })
				.request(createOp.method.toUpperCase(), fillPath(createOp.path, shared.scope), {
					as: { principal: shared.owner.id },
					body: encoded.body,
					operationId: createOp.operationId,
					...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
				})
		}
		const { exchange, exhausted } = await createWithClientId(
			reserveIdentity(bodyOf(ctx, { createOp, label }), at),
			send,
			at,
		)
		if (exhausted !== undefined) return { untested: exhausted }
		const made = targetRecord(ctx, op, ctx.ledger.entries().slice(before))
		return made ?? { untested: `${createOp.operationId} answered ${exchange.status}` }
	} catch (error) {
		/* A creator whose credential is BLOCKED stops the probe as the read back would: say so, never just stand down. */
		const blocked = error instanceof UnsatisfiedSecurity && error.kind === "blocked" ? { blocked: error } : {}
		return { untested: messageOf(error), ...blocked }
	}
}

/*
 * A valid body for the create, as an ancestor's is drawn: every string and unique value carries the
 * run's nonce and the throwaway's label, so it never takes a value the cohort or another throwaway holds.
 */
function bodyOf(
	ctx: RunContext,
	{ createOp, label }: { createOp: OperationModel; label: string },
): Record<string, unknown> {
	const schema = requestSchemaOf(createOp, ctx.model)
	const unique = createOp.unique ?? []
	/* One variant asked for, one member made. */
	const [member] = buildCohort(schema ?? {}, ctx.seed, {
		defs: ctx.model.defs,
		distinct: new Set([...unique.flat(), ...stringProperties(schema)]),
		nonce: `${ctx.nonce}${label}`,
		operationId: createOp.operationId,
		variants: ["baseline"],
	}) as [CohortMember]
	return uniquifyProbeBody(member.body, unique, { schema, token: `${label}-${ctx.nonce}` })
}
