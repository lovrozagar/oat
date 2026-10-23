import { requestContent } from "../../../../spec/collection/request.ts"
import type { InviteSpec } from "../../../../spec/extensions/invite.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { resolveOutOfBandValue, sentAt } from "../../../steps/out-of-band.ts"
import type { Exchange } from "../../../exchange.ts"
import { isAbsoluteHttpUrl } from "../../../cookies/redirect.ts"
import { fillPath } from "../../../fill-path.ts"
import type { Outcome } from "../../../finding.ts"
import type { Actor as RequestActor } from "../../../../client/credential-source.ts"
import { readPath } from "../../../../client/read-path.ts"
import { idOf } from "../../../world/records.ts"
import type { Actor, CheckContext, WriteContext } from "../../core/context.ts"
import { itemParamFor } from "../../planning/subjects.ts"

/*
 * The steps of auth.invite-grants-then-revokes that address the backend: the read the grant
 * opens, the token, the accept request and the revoke, with the request bodies they declare.
 * The check decides what each answer means.
 */

/** What the check's plan hands its run. */
export interface InvitePlan {
	spec: InviteSpec
	owner: Actor
	delegate: Actor
	inviteAs: string
	inviteOp: OperationModel
	acceptOp: OperationModel
	revokeOp: OperationModel
	grantsOp: OperationModel | undefined
}

export function pointerValue(body: unknown, pointer: string): string | undefined {
	const node = readPath(body, pointer)
	/* Grant and job ids are as often numbers as strings. */
	if (typeof node === "number" && Number.isFinite(node)) return String(node)
	return typeof node === "string" && node !== "" ? node : undefined
}

/** One run of the invite flow: what it addresses, and what it has learned so far. */
export interface Flow {
	ctx: WriteContext
	check: string
	plan: InvitePlan
	/** The inviter's scope with the record the check reads. */
	resource: Record<string, string>
	/** The read the grant opens, or `undefined` when there is none to try. */
	grantRead: { operationId: string; path: string } | undefined
	subjectLabel: string
	/** The invite token, once known; accept and revoke fill it into their path or body. */
	token: string | undefined
	/** Whether revoke was sent, so the cleanup does not send it twice. */
	revoked: boolean
}

export function inviteFlow(ctx: WriteContext, check: string, plan: InvitePlan): Flow {
	const { grantsOp } = plan
	const id = idOf(ctx.records[0], ctx.identity)
	const grantRead =
		grantsOp !== undefined
			? { operationId: grantsOp.operationId, path: grantsOp.path }
			: ctx.readOp === undefined || id === undefined
				? undefined
				: { operationId: ctx.readOp.operationId, path: ctx.readOp.path }
	return {
		check,
		ctx,
		grantRead,
		plan,
		resource: { ...ctx.scope, ...(id === undefined ? {} : itemParamFor(ctx, id)) },
		revoked: false,
		subjectLabel: grantsOp === undefined ? `${ctx.entityName} ${id}` : `${grantsOp.operationId} on the inviter's scope`,
		token: undefined,
	}
}

/** Whether the delegate can read what the grant opens; `null` when there is no read to try. */
export async function canRead({ ctx, grantRead, plan, resource }: Flow): Promise<boolean | null> {
	if (grantRead === undefined) return null
	const exchange = await ctx.client.get(fillPath(grantRead.path, { ...plan.delegate.scope, ...resource }), {
		as: { principal: plan.delegate.id },
		operationId: grantRead.operationId,
	})
	return exchange.status < 300
}

/**
 * The scheme an operation's first alternative that asks for a credential names first, or
 * `undefined` when it asks for none: where a credential the flow hands a principal goes.
 */
export function schemeOf(op: OperationModel | undefined): string | undefined {
	return op?.security.alternatives.find((alternative) => alternative.length > 0)?.[0]?.scheme
}

/**
 * Holds the credential an accept issued as the delegate's, under the scheme the grant's read asks
 * for, so that read, and every later request as the delegate, sends it.
 */
export async function adoptIssued({ ctx, grantRead, plan }: Flow, issued: string): Promise<void> {
	const scheme = schemeOf(grantRead === undefined ? undefined : ctx.model.byOperationId.get(grantRead.operationId))
	if (scheme === undefined || ctx.credentials === undefined) return
	await ctx.credentials.adopt({ principal: plan.delegate.id, scheme, value: issued })
}

/* The grant is its own record: revoke addresses it, not the record the check read first. */
export function revoke(flow: Flow, grant: string): Promise<Exchange> {
	const { ctx, plan, resource, token } = flow
	const { owner, revokeOp } = plan
	flow.revoked = true
	const revokeParam = revokeOp.pathParams.at(-1)
	const revokeScope = {
		...resource,
		...(revokeParam === undefined || revokeParam in ctx.scope ? {} : { [revokeParam]: grant }),
		grant_id: grant,
		...(token === undefined ? {} : { token }),
	}
	const revokeBody = documentedJsonBody(ctx, revokeOp, revokeScope)
	return ctx.client.request(revokeOp.method, fillPath(revokeOp.path, revokeScope), {
		...(revokeBody === undefined ? {} : { body: revokeBody, headers: { "content-type": "application/json" } }),
		as: { principal: owner.id },
		operationId: revokeOp.operationId,
	})
}

/** The invite token: delivered out of band, or read from the invite's answer. */
export async function inviteToken(flow: Flow, invited: Exchange): Promise<string | { outcome: Outcome }> {
	const { check, ctx, plan, resource } = flow
	const { inviteAs, spec } = plan
	if (spec.tokenFrom !== "outOfBand") {
		const token = pointerValue(invited.responseBody, spec.tokenPointer)
		if (token !== undefined) return token
		return {
			outcome: ctx.findings.unresolved(check, ctx.entityName, `invite response has no token at ${spec.tokenPointer}`),
		}
	}
	const kind = spec.tokenKind ?? `${ctx.entityName}-invite`
	try {
		return await resolveOutOfBandValue(ctx.hooks.resolveOutOfBand, inviteAs, {
			kind,
			label: `invite to ${ctx.entityName}`,
			outOfBand: ctx.outOfBand,
			scope: { ...resource, inviteAs },
			since: sentAt(invited),
		})
	} catch (error) {
		return {
			outcome: ctx.findings.unresolved(check, ctx.entityName, error instanceof Error ? error.message : String(error)),
		}
	}
}

/** The accept request: a GET of the mailed link, or the accept operation with the token. */
export async function sendAccept(flow: Flow, token: string): Promise<{ exchange: Exchange } | { outcome: Outcome }> {
	const { check, ctx, plan, resource } = flow
	const { acceptOp, delegate, spec } = plan
	if (spec.acceptFrom === "link") {
		if (!isAbsoluteHttpUrl(token)) {
			const reason = `x-invite.acceptFrom: link needs an absolute http(s) URL, got ${JSON.stringify(token)}`
			return { outcome: ctx.findings.unresolved(check, ctx.entityName, reason) }
		}
		/* A link names no operation, so the scheme the accept asks for is named outright, and an accept
		 * that asks for none is sent as nobody: the link itself is the credential. */
		const scheme = schemeOf(acceptOp)
		const as: RequestActor = scheme === undefined ? { anonymous: true } : { principal: delegate.id, scheme }
		return { exchange: await ctx.client.request("GET", token, { as, redirect: "follow" }) }
	}
	const acceptScope = { ...resource, token }
	const acceptBody = documentedJsonBody(ctx, acceptOp, acceptScope)
	const exchange = await ctx.client.request(acceptOp.method, fillPath(acceptOp.path, acceptScope), {
		...(acceptBody === undefined ? {} : { body: acceptBody, headers: { "content-type": "application/json" } }),
		as: { principal: delegate.id },
		operationId: acceptOp.operationId,
	})
	return { exchange }
}

/**
 * JSON request body declared on the operation, filled from known flow values.
 *
 * Path-only accept/revoke (`POST /invites/{token}` with no body) stay path-only.
 */
export function documentedJsonBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, string>,
): Record<string, unknown> | undefined {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	if (picked === null || !picked.mediaType.includes("json")) return undefined
	const properties = picked.schema.properties
	if (properties !== null && typeof properties === "object") {
		const names = Object.keys(properties as object)
		if (names.length > 0) {
			const body: Record<string, unknown> = {}
			for (const name of names) {
				if (fields[name] !== undefined) body[name] = fields[name]
			}
			return body
		}
	}
	if (fields["token"] !== undefined) return { token: fields["token"] }
	if (fields["grant_id"] !== undefined) return { grant_id: fields["grant_id"] }
	return { ...fields }
}
