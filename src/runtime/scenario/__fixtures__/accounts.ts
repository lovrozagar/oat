import type { ScenarioStep } from "../../../config/types/steps.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { AccountEntry } from "../../accounts/ledger.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import { modelOf } from "../../checks/__fixtures__/harness.ts"
import type { Exchange } from "../../exchange.ts"
import type { ScenarioAccounts } from "../lineage.ts"

/*
 * A sign-up API for scenario lineage: a sign-up that answers a token and a refresh token, a refresh
 * that rotates it, and a delete of the caller's own account. The accounts port is a fake: each
 * sign-up answer is its own ledger entry, and each self delete it is told of is kept.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const tokens = { properties: { refresh: { type: "string" }, token: { type: "string" } }, type: "object" }

export const accountsDoc = {
	info: { title: "accounts", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/account": { delete: { operationId: "auth.deleteAccount", responses: { "204": { description: "gone" } } } },
		"/refresh": {
			post: { operationId: "auth.refresh", requestBody: json(tokens), responses: { "200": json(tokens) } },
		},
		"/register": {
			post: { operationId: "auth.register", requestBody: json(tokens), responses: { "201": json(tokens) } },
		},
	},
} as unknown as OpenApiDocument

export const accountsModel = modelOf(accountsDoc)

/** The answers by `METHOD /path`; a sign-up answers fresh tokens unless one is given. */
export function accountsApi(answers: Record<string, Answer | (() => Answer)> = {}): Responder {
	let made = 0
	return (method, path) => {
		const fixed = answers[`${method} ${path}`]
		if (fixed !== undefined) return typeof fixed === "function" ? fixed() : fixed
		if (path === "/register") {
			made += 1
			return { body: { refresh: `r${made}`, token: `t${made}` }, status: 201 }
		}
		if (path === "/refresh") return { body: { token: "rotated" }, status: 200 }
		return { status: 204 }
	}
}

const entryOf = (n: number): AccountEntry => ({
	identity: { email: `u${n}@b.test` },
	n,
	operationId: "auth.register",
	status: "created",
})

/**
 * The fake port, and the entries it was asked about and told deleted themselves. A sign-up answer's
 * entry is numbered by the token it answered, so `t2` is entry 2, whichever send answered it.
 */
export function accountsPort(): {
	port: ScenarioAccounts
	deleted: Array<{ entry: AccountEntry; exchange: Exchange }>
} {
	const entries = new Map<string, AccountEntry>()
	const deleted: Array<{ entry: AccountEntry; exchange: Exchange }> = []
	const port: ScenarioAccounts = {
		deleteSelf: "auth.deleteAccount",
		deletedItself: (entry, exchange) => deleted.push({ entry, exchange }),
		madeBy: (exchange) => {
			if (exchange.operationId !== "auth.register") return undefined
			const token = String((exchange.responseBody as { token: string }).token)
			if (!entries.has(token)) entries.set(token, entryOf(Number(token.slice(1))))
			return entries.get(token)
		},
	}
	return { deleted, port }
}

/** The tester's reauth flow: sign up, refresh with the saved refresh token, delete through the rotated session. */
export const signUp: ScenarioStep = {
	anonymous: true,
	body: { refresh: "", token: "" },
	operationId: "auth.register",
	saveAs: { credential: "$.token", refreshToken: "$.refresh" },
}
export const refresh: ScenarioStep = {
	anonymous: true,
	body: { refresh: "{refreshToken}" },
	operationId: "auth.refresh",
	saveAs: { rotated: "$.token" },
}
export const deleteThroughSession: ScenarioStep = {
	anonymous: true,
	headers: { authorization: "Bearer {rotated}" },
	operationId: "auth.deleteAccount",
}
