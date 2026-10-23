import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { probeOwner } from "../probe-principal.ts"
import { createStore } from "../store.ts"
import type { CredentialRecord } from "../ports.ts"
import type { SignupOperation } from "../signup.ts"
import { jwtOf } from "./jwt.ts"
import { answerOf, BEARER, fakePorts, NOW, type RunCall } from "./ports.ts"

/* A store over counting fakes, for the store's tests and the dedicated credentials'. */

export const KEY: SecurityScheme = {
	deprecated: false,
	in: "header",
	kind: "apiKey",
	name: "key",
	param: "Authorization",
}
export const SCHEMES: ReadonlyMap<string, SecurityScheme> = new Map<string, SecurityScheme>([
	["jwt", BEARER],
	["key", KEY],
	["basic", { deprecated: false, kind: "basic", name: "basic" }],
	["digest", { deprecated: false, kind: "unsupported", name: "digest", unsupported: "http digest" }],
])
export const SECURITY: SecurityConfig = {
	digest: { static: "d" },
	jwt: {
		expiresIn: 60,
		login: {
			from: "$.token",
			revoke: "auth.logout",
			steps: [{ body: { email: "{principal.email}" }, operationId: "auth.login" }],
		},
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
	key: {
		format: "ApiKey {credential}",
		mint: {
			body: { scopes: "{scopes}" },
			from: "$.key",
			operationId: "apiKey.create",
			revoke: "apiKey.revoke",
			with: "jwt",
		},
	},
}
export const PRINCIPALS: PrincipalsConfig = {
	ann: { created: true, email: "ann@x.io", rank: 2, tenant: "t1" },
	bob: { email: "bob@x.io", security: { jwt: { static: "bob-static" } } },
	cy: { email: "cy@x.io" },
	dee: {
		email: "dee@x.io",
		security: {
			jwt: { login: { claims: { tenant: "org_id" }, from: "$.token", steps: [{ operationId: "auth.login" }] } },
		},
	},
}

/** What the fakes refuse. The sets are live: a test may add to one mid-run. */
export interface Faults {
	login?: Set<string>
	refresh?: Set<string>
	mint?: (count: number) => boolean
	revoke?: (scope: Readonly<Record<string, string>> | undefined) => number
	/** Whether the run already saw a minted key's record removed. Default: never. */
	removed?: (record: CredentialRecord) => boolean
	/** Whether a minted key's record reads back gone. Default: never. */
	gone?: (record: CredentialRecord) => boolean
	/** Status a logout answers. Default: 204. */
	logout?: () => number
	/** A refresh from a credential already refreshed is refused, as a rotating server's reuse detection does. */
	rotates?: boolean
	signup?: SignupOperation
}

/** A store over counting fakes: a login or refresh issues `<principal>-<n>`, a mint issues `k<n>`. */
export function harness(faults: Faults = {}) {
	const clock = { now: NOW }
	let issued = 0
	let mints = 0
	const refreshed = new Set<string>()
	const signIn = (call: RunCall) => {
		const refreshing = "operationId" in call.steps[0]! && call.steps[0].operationId === "auth.refresh"
		if ((refreshing ? faults.refresh : faults.login)?.has(call.principal)) {
			return Promise.reject(new Error(refreshing ? "refresh token reused" : "auth step 1 answered 401"))
		}
		const from = call.scope["credential"]
		if (refreshing && faults.rotates === true && from !== undefined) {
			if (refreshed.has(from)) return Promise.reject(new Error("auth step 1 answered 401"))
			refreshed.add(from)
		}
		issued++
		const token = probeOwner(call.principal) === "dee" ? jwtOf({ org_id: "o7" }) : `${call.principal}-${issued}`
		return Promise.resolve({ answer: answerOf({ token }), scope: {} })
	}
	const { ports, recorded } = fakePorts({
		call: (operationId, _body, as) => {
			/* As the run's client does: a principal blocked for the `with` scheme sends nothing. */
			if (faults.login?.has(as.principal))
				return Promise.reject(new Error(`"${as.principal}" is BLOCKED for ${as.scheme}`))
			if (operationId === "auth.logout") return Promise.resolve(answerOf(null, faults.logout?.() ?? 204))
			if (operationId === "apiKey.revoke") {
				const scope = recorded.calls.at(-1)?.scope
				return Promise.resolve(answerOf(null, faults.revoke?.(scope) ?? 204))
			}
			mints++
			return Promise.resolve(faults.mint?.(mints) ? answerOf({}, 500) : answerOf({ id: mints, key: `k${mints}` }))
		},
		gone: (record) => Promise.resolve(faults.gone?.(record) ?? false),
		removed: (record) => faults.removed?.(record) ?? false,
		run: signIn,
	})
	const store = createStore({
		now: () => clock.now,
		ports,
		principals: PRINCIPALS,
		schemes: SCHEMES,
		security: SECURITY,
		...(faults.signup === undefined ? {} : { signup: faults.signup }),
	})
	const mintCalls = () => recorded.calls.filter((call) => call.operationId === "apiKey.create")
	return { clock, mintCalls, recorded, store }
}
