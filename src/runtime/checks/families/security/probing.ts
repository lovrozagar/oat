/*
 * What the security checks share: where a probe of an operation goes, how it is sent, and how a probe
 * that must be refused is judged. A collection read is probed under the actor's own scope; a read of
 * one record, or a write, only on the record the run created (`ctx.target`). A write's body is that
 * record's current state cut to what the request accepts (`writableBody`): harmless if a broken API
 * applies it, and never a readOnly property a strict one refuses before it judges the caller.
 */

import type { Actor } from "../../../../client/credential-source.ts"
import type { RequestOptions } from "../../../../client/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { noSecurityReason } from "../../../no-security.ts"
import type { SpecModel } from "../../../../spec/graph/types.ts"
import type { Requirement, ResolvedSecurity } from "../../../../spec/security/requirements.ts"
import type { CheckId } from "../../../check-ids.ts"
import type { Actor as Principal } from "../../core/context.ts"
import { targetPlan } from "../../core/operation.ts"
import type { OperationContext, WriteTarget } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready, when } from "../../core/plan.ts"
import { currentOf, writableBody } from "./writable.ts"

/** Where a probe of the operation goes, and the body it carries. */
export interface Address {
	path: string
	body?: unknown
	contentType?: string
}

/** A client either stage hands a check: a read-only one sends reads alone. */
interface Sender {
	request(method: string, path: string, options: RequestOptions): Promise<Exchange>
}

/** What `send` needs of a context. */
export type Sending = Pick<OperationContext, "operation"> & { client: Sender }

/** Stands down where the document declares no security: a refusal is due only where one is declared. */
export function declaredPlan(ctx: Pick<OperationContext, "operation">): Plan<undefined> {
	const undeclared = noSecurityReason(ctx.operation)
	return undeclared === undefined ? ready(undefined) : cannot(undeclared)
}

/** Stands down unless the security is declared and requires a credential: only then is a refusal due. */
export function securedPlan(ctx: Pick<OperationContext, "operation" | "security" | "subject">): Plan<undefined> {
	return andThen(declaredPlan(ctx), () =>
		when(
			!allowsAnonymous(ctx.security),
			`an operation that requires a credential; ${ctx.subject} lets anonymous callers in`,
		),
	)
}

/**
 * Who an acceptance probe acts as, and the control it is compared with: the target record's creator,
 * so the outcome it expects is acceptance. A record another principal made is no proof the actor may
 * read it. With no target, or one whose creator is no principal of the run, the actor. A refusal
 * probe keeps its own sender: nobody, a forged credential, another scheme, or a deliberate peer.
 */
export function acceptorOf(ctx: Pick<OperationContext, "actor" | "principals" | "target">): Principal {
	const owner = ctx.target?.owner
	return ctx.principals.find((principal) => principal.id === owner) ?? ctx.actor
}

/**
 * Where the probe goes, by its placement: a collection read under the actor's scope; a read of one
 * record, or a write, to the run-created target alone, never anywhere else.
 */
export function addressOf(ctx: OperationContext): Plan<Address> {
	if (ctx.placement === "read") return scopedAddress(ctx)
	return andThen(targetPlan(ctx), (target) => targetAddress(ctx, target))
}

/** The operation's path under the actor's scope, or a stand-down naming the parameters it lacks. */
export function scopedAddress(ctx: Pick<OperationContext, "actor" | "operation">): Plan<Address> {
	const { actor, operation } = ctx
	const missing = operation.pathParams.filter((name) => !Object.hasOwn(actor.scope, name))
	return andThen(
		when(missing.length === 0, `a value for ${missing.join(" and ")} in ${operation.operationId}'s path`),
		() => ready({ path: fillPath(operation.path, actor.scope) }),
	)
}

/* The target's path, and for a write that takes a body, the target's current state as that body. */
function targetAddress(ctx: OperationContext, target: WriteTarget): Plan<Address> {
	if (ctx.placement !== "write" || !ctx.operation.hasRequestBody) return ready({ path: target.path })
	const record = currentOf(target)
	if (record === undefined) return cannot("the target record's current state, for a harmless body")
	return ready({ body: writableBody(ctx, record), path: target.path })
}

/**
 * Sends one probe of the operation as `as`. A probe that expects a refusal (the default) is marked
 * one, so the client never refreshes or retries its 401; an `answer` is sent as any request is.
 */
export function send(
	ctx: Sending,
	address: Address,
	as: Actor,
	expects: "refusal" | "answer" = "refusal",
): Promise<Exchange> {
	const { operation } = ctx
	const options: RequestOptions = { as, operationId: operation.operationId }
	if (expects === "refusal") options.probe = true
	if (Object.keys(operation.requiredQuery).length > 0) options.query = { ...operation.requiredQuery }
	if (address.body !== undefined) options.body = address.body
	if (address.contentType !== undefined) options.contentType = address.contentType
	return ctx.client.request(operation.method.toUpperCase(), address.path, options)
}

/** Whether a status refuses the request's credential. */
export function refused(status: number): boolean {
	return status === 401 || status === 403
}

/** Why a refusal probe answered 400 or 422 proves nothing: see `byValidation`. */
export const BY_VALIDATION = "refused by validation before authorization could be observed"

/**
 * Whether the answer came from validation: 400 or 422. Never a pass, since an API that validates
 * before it authenticates would hide an unguarded route behind it; the probe is inconclusive.
 */
export function byValidation(status: number): boolean {
	return status === 400 || status === 422
}

/** Whether the security lets an anonymous caller in: `[]`, or an empty alternative. */
export function allowsAnonymous(security: ResolvedSecurity): boolean {
	return security.alternatives.some((alternative) => alternative.length === 0)
}

/** The alternatives of exactly one scheme, the first of each scheme: what one credential satisfies alone. */
export function singleSchemes(security: Pick<ResolvedSecurity, "alternatives">): Requirement[] {
	const seen = new Set<string>()
	const single: Requirement[] = []
	for (const [requirement, ...rest] of security.alternatives) {
		if (requirement === undefined || rest.length > 0 || seen.has(requirement.scheme)) continue
		seen.add(requirement.scheme)
		single.push(requirement)
	}
	return single
}

/** Every declared scheme an operation of the document names, with the scopes it is first named with. */
export function documentSchemes(model: SpecModel): Requirement[] {
	const first = new Map<string, Requirement>()
	for (const { security } of model.operations) {
		for (const requirement of security.alternatives.flat()) {
			if (security.undeclared.includes(requirement.scheme) || first.has(requirement.scheme)) continue
			first.set(requirement.scheme, requirement)
		}
	}
	return [...first.values()]
}

/** The security in words: `jwt, or apiKey with notes:read`. */
export function describeSecurity(security: Pick<ResolvedSecurity, "alternatives">): string {
	return security.alternatives
		.map((alternative) => (alternative.length === 0 ? "no credential" : alternative.map(described).join(" and ")))
		.join(", or ")
}

/* One scheme in words, with the scopes it must carry. */
function described({ scheme, scopes }: Requirement): string {
	return scopes.length === 0 ? scheme : `${scheme} with ${scopes.join(" ")}`
}

/** One probe that must be refused: its answer, what it sent in the reader's terms, and the finding's line. */
export interface Refusal {
	exchange: Exchange
	sent: string
	summary: string
}

/**
 * The verdict on probes that must each be refused: SECURITY for every one answered with a success,
 * unresolved when one drew neither a refusal nor a success, else asserted.
 */
export function judgeRefusals(
	ctx: Pick<OperationContext, "findings" | "security" | "subject">,
	check: CheckId,
	probes: readonly Refusal[],
): Outcome {
	const accepted = probes.filter(({ exchange }) => exchange.status >= 200 && exchange.status < 300)
	let outcome: Outcome = ASSERTED
	for (const { exchange, sent, summary } of accepted) {
		outcome = ctx.findings.security(check, ctx.subject, {
			detail: `${ctx.subject} answered ${exchange.status} to ${sent}. The document requires ${describeSecurity(ctx.security)}.`,
			evidence: [exchange],
			summary,
		})
	}
	if (accepted.length > 0) return outcome
	const other = probes.find(({ exchange }) => !refused(exchange.status))
	if (other === undefined) return ASSERTED
	const why = byValidation(other.exchange.status) ? BY_VALIDATION : "neither a refusal nor a success"
	const reason = `${ctx.subject} answered ${other.exchange.status} to ${other.sent}: ${why}`
	return ctx.findings.unresolved(check, ctx.subject, reason)
}
