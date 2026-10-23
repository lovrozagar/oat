/** `x-invite`: the invite, accept and revoke operations of a grant, and where each reads its pieces. */

import type { OperationObject } from "../types.ts"
import { extObject } from "./tag.ts"

export interface InviteSpec {
	invite: string
	accept: string
	revoke: string
	granteeField: string
	tokenPointer: string
	grantPointer: string
	/** Where the accept token comes from. Default `response` keeps `tokenPointer`. */
	tokenFrom: "response" | "outOfBand"
	/** `resolveOutOfBand` kind when `tokenFrom` is `outOfBand`. Default `${entity}-invite`. */
	tokenKind?: string
	/**
	 * How the invitee consumes the token. Default `token` stuffs it into the documented accept
	 * JSON / path. `link` GETs the out-of-band value as an absolute URL (the mailed consume hop).
	 */
	acceptFrom?: "token" | "link"
	/**
	 * JSON path of a credential in a 2xx accept body. When it is a non-empty string, the invitee
	 * uses it for the grant read. Missing means the invitee keeps the credential it already had.
	 * Default `$.access_token`.
	 */
	credentialFrom: string
	/**
	 * operationId of the read the accepted invite opens, filled from the inviter's scope. Default:
	 * the invite entity's own item read. Name it when the grant opens a parent (an organization)
	 * rather than the record the invite creates.
	 */
	grants?: string
}

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback)

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== ""

export function readInvite(op: OperationObject): InviteSpec | null {
	const tag = extObject<InviteSpec>(op, "x-invite")
	if (tag === undefined) return null
	const { invite, accept, revoke } = tag
	if (typeof invite !== "string" || typeof accept !== "string" || typeof revoke !== "string") return null
	const spec: InviteSpec = {
		accept,
		credentialFrom: nonEmpty(tag.credentialFrom) ? tag.credentialFrom : "$.access_token",
		grantPointer: stringOr(tag.grantPointer, "$.grant_id"),
		granteeField: stringOr(tag.granteeField, "key"),
		invite,
		revoke,
		tokenFrom: tag.tokenFrom === "outOfBand" ? "outOfBand" : "response",
		tokenPointer: stringOr(tag.tokenPointer, "$.token"),
	}
	if (nonEmpty(tag.tokenKind)) spec.tokenKind = tag.tokenKind
	if (nonEmpty(tag.grants)) spec.grants = tag.grants
	if (tag.acceptFrom === "link") spec.acceptFrom = "link"
	return spec
}
