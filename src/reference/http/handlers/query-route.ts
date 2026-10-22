/** The search route, read by QUERY: a payment method arrives in a JSON body, and nothing changes. */

import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { respond } from "../wire.ts"
import type { Route } from "./fixed.ts"

/* Each branch's own field and the test its value must pass; the tag names the branch. */
const BRANCHES = {
	bank: { field: "account", valid: (value: string) => value.length > 0 && value.length <= 34 },
	card: { field: "last4", valid: (value: string) => /^[0-9]{4}$/.test(value) },
} as const

type Kind = keyof typeof BRANCHES

const OTHER: Record<Kind, Kind> = { bank: "card", card: "bank" }

/* The body's method, when its tag names a branch and it holds exactly that branch's field, valid. */
function methodOf(body: unknown): { kind: Kind; value: string } | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null
	const { kind, ...rest } = body as Record<string, unknown>
	if (kind !== "bank" && kind !== "card") return null
	const { field, valid } = BRANCHES[kind]
	const value = rest[field]
	const only = Object.keys(rest).length === 1 && typeof value === "string" && valid(value)
	return only ? { kind, value } : null
}

export const search: Route = async (state, request) => {
	if (request.method !== "QUERY" || request.url.pathname !== "/v1/search") return undefined
	requireJson(request, state.defects)
	const method = methodOf(await readJson(request))
	if (method === null) {
		throw new HttpError(400, "invalid_input", 'the body must be a card ("last4") or a bank account ("account")')
	}
	/* The defect keeps the asked fields and names the other branch: each field fits, the tag does not. */
	const kind = state.defects.has("DISCRIMINATOR_BRANCH_WRONG") ? OTHER[method.kind] : method.kind
	return respond(200, { kind, [BRANCHES[method.kind].field]: method.value })
}
