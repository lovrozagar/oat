/**
 * An account-making operation the document does not tag `x-fresh-principal`: an open POST named
 * as a sign-up, or an open collection create that takes a password. oat ledgers what it sends there
 * like any sign-up, so an account it makes on an untagged document is named, never left silent.
 * Tagging the operation lets oat sign in as the account and remove it.
 */

import { requestSchema } from "../../spec/collection/request.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { SIGN_IN } from "../../spec/sign-in.ts"
import type { OperationObject } from "../../spec/types.ts"

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
	/* Every operation of a built model has its raw operation. */
	return takesPassword(requestSchema(model.rawOperations.get(op.operationId) as OperationObject))
}
