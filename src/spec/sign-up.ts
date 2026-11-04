/**
 * The operations that make an account, the one rule every reader of it shares: the operation the
 * document marks `x-fresh-principal`, a create of the `identity: self` entity, and a sign-up the
 * document leaves unmarked. The ledger records what is sent there, teardown removes it, and the
 * credential store never renews a login by calling one again.
 *
 * An unmarked sign-up is an open POST named as a sign-up, or an open collection create that takes a
 * password and resets, recovers or changes none. oat ledgers what it sends there like any sign-up,
 * so an account it makes on an untagged document is named, never left silent. Tagging the
 * operation lets oat sign in as the account and remove it.
 */

import { requestSchema } from "./collection/request.ts"
import type { OperationModel, SpecModel } from "./graph/types.ts"
import { SIGN_IN } from "./sign-in.ts"
import type { OperationObject } from "./types.ts"

/** `x-entity.identity: self`: the signed-up caller is the record. */
export const SELF_IDENTITY = "self"

/** An operation that makes an account, as the credential store matches a login step against it. */
export interface SignupOperation {
	operationId: string
	method: string
	/** Its path template, below the primary base URL. */
	path: string
}

/* A name's words, in order: split on `-`, `_`, `/`, `.`, spaces and camelCase, lowercased. */
function words(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_/.\s]+/)
		.filter((word) => word !== "")
		.join(" ")
		.toLowerCase()
}

const SIGN_UP = /(?:^| )(?:register|registration|signup|sign up)$/

/* The words of a route that sets a password on an account that already exists. */
const PASSWORD_ONLY = /(?:^| )(?:reset|forgot|recover|change)(?: |$)/

/* The path's last segment, unless it is a parameter. */
function lastSegment(path: string): string | undefined {
	const segment = path
		.split("/")
		.filter((part) => part !== "")
		.at(-1)
	return segment === undefined || segment.startsWith("{") ? undefined : segment
}

/* A top-level property that carries a password. */
function takesPassword(schema: unknown): boolean {
	const properties = (schema as { properties?: unknown } | null)?.properties
	if (properties === null || typeof properties !== "object") return false
	return Object.entries(properties as Record<string, unknown>).some(
		([name, property]) =>
			/^(password|passphrase)$/i.test(name) || (property as { format?: unknown } | null)?.format === "password",
	)
}

export function unmarkedSignUp(op: OperationModel, model: SpecModel): boolean {
	if (op.method.toUpperCase() !== "POST") return false
	if (!op.security.alternatives.every((alternative) => alternative.length === 0)) return false
	const segment = lastSegment(op.path)
	const names = segment === undefined ? [op.operationId] : [op.operationId, segment]
	if (names.some((name) => SIGN_UP.test(words(name)))) return true
	/* A collection create, not a sign-in: an item route's POST changes a record, not who exists. */
	if (segment === undefined || names.some((name) => SIGN_IN.test(name))) return false
	/* A password reset, forgotten, recovered or changed takes one too, and makes no account. */
	if (names.some((name) => PASSWORD_ONLY.test(words(name)))) return false
	/* Every operation of a built model has its raw operation. */
	return takesPassword(requestSchema(model.rawOperations.get(op.operationId) as OperationObject))
}

/**
 * How sending an operation makes an account: `always`, a sign-up; `anonymously`, a create of the
 * caller's own record anyone may send, which makes one only when it carries no credential, since a
 * caller who carries one already has its account; or `null`, never.
 */
export type AccountMaking = "always" | "anonymously" | null

export function accountMaking(op: OperationModel, model: SpecModel): AccountMaking {
	if (op.freshPrincipal || unmarkedSignUp(op, model)) return "always"
	const self = op.action === "create" && op.identity === SELF_IDENTITY
	return self && op.security.alternatives.some((alternative) => alternative.length === 0) ? "anonymously" : null
}

/** Whether sending `op` can make an account. */
export function makesAccount(op: OperationModel, model: SpecModel): boolean {
	return accountMaking(op, model) !== null
}

/** Every operation of the document that can make an account, in document order. */
export function accountMakersOf(model: Pick<SpecModel, "operations" | "rawOperations">): SignupOperation[] {
	return model.operations
		.filter((op) => makesAccount(op, model as SpecModel))
		.map((op) => ({ method: op.method, operationId: op.operationId, path: op.path }))
}
