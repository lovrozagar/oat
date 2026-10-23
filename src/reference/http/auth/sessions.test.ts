import { describe, expect, it } from "vitest"
import { memoryStore } from "../engines.ts"
import { HttpError } from "../errors.ts"
import { referenceState } from "../reference.ts"
import { PRINCIPALS, type ReferenceOptions } from "../state.ts"
import { decodeJwt, signJwt } from "./jwt.ts"
import { accessPrincipal, issueSession, killAll, newAuthState, revokeJwt, rotate } from "./sessions.ts"

const [ALPHA, BETA] = PRINCIPALS as [(typeof PRINCIPALS)[0], (typeof PRINCIPALS)[0]]
const T0 = 1_800_000_000_000

/* A reference whose clock reads `now.ms`, which a test moves. */
async function world(options: ReferenceOptions = {}) {
	const now = { ms: T0 }
	const state = await referenceState({ clock: () => now.ms, ...options }, memoryStore)
	return { now, state }
}

/* The refusal `run` throws: its status and message. */
function refusal(run: () => unknown): { status: number; message: string } {
	try {
		run()
	} catch (error) {
		if (error instanceof HttpError) return { message: error.message, status: error.status }
	}
	throw new Error("no refusal")
}

const flip = (token: string): string => `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`

describe("newAuthState", () => {
	it("seeds the principals as accounts, throttles only when asked, and reads the wall clock by default", () => {
		const auth = newAuthState({})
		expect([...auth.accounts.keys()]).toEqual(PRINCIPALS.map((principal) => principal.key))
		expect(auth.throttle).toBe(false)
		expect(newAuthState({ throttleLogins: true }).throttle).toBe(true)
		expect(Math.abs(auth.clock() - Date.now())).toBeLessThan(5000)
	})
})

describe("issueSession", () => {
	it("issues an access and a refresh JWT in one new family, with the account's tenant, role and expiry", async () => {
		const { state } = await world()
		const session = issueSession(state, BETA)
		expect(session).toMatchObject({ expires_in: 3600, project_id: "proj_beta" })
		const access = decodeJwt(state.auth.secret, session.access_token)
		const refresh = decodeJwt(state.auth.secret, session.refresh_token)
		expect(access).toEqual({
			claims: {
				exp: T0 / 1000 + 3600,
				fam: "fam_1",
				iat: T0 / 1000,
				jti: "jti_2",
				project_id: "proj_beta",
				role: "admin",
				sub: "key_beta",
				typ: "access",
			},
			signed: true,
		})
		expect(refresh?.claims).toMatchObject({ exp: T0 / 1000 + 30 * 86_400, fam: "fam_1", jti: "jti_3", typ: "refresh" })
	})

	it("spells the expiry as a string under TOKEN_EXPIRY_AS_STRING", async () => {
		const { state } = await world({ defects: ["TOKEN_EXPIRY_AS_STRING"] })
		expect(issueSession(state, ALPHA).expires_in).toBe("3600")
	})
})

describe("roles", () => {
	it("maps each rank to its role and back: admin 2, member 1, viewer 0", async () => {
		const { state } = await world()
		const roundTrip = PRINCIPALS.map((account) => {
			const token = issueSession(state, account).access_token
			return [decodeJwt(state.auth.secret, token)?.claims["role"], accessPrincipal(state, token).rank]
		})
		expect(roundTrip).toEqual([
			["admin", 2],
			["admin", 2],
			["member", 1],
			["viewer", 0],
		])
	})
})

describe("accessPrincipal", () => {
	it("authenticates a live access token as its subject, tenant, role and token id", async () => {
		const { state } = await world()
		const member = PRINCIPALS[2] as (typeof PRINCIPALS)[0]
		expect(accessPrincipal(state, issueSession(state, member).access_token)).toEqual({
			jti: "jti_2",
			key: "key_alpha_member",
			projectId: "proj_alpha",
			rank: 1,
		})
	})

	it("refuses what is not a JWT, a bad signature, a refresh token, an expired token and malformed claims", async () => {
		const { now, state } = await world()
		const { access_token: access, refresh_token: refresh } = issueSession(state, ALPHA)
		expect(refusal(() => accessPrincipal(state, "tok_alpha"))).toEqual({ message: "malformed token", status: 401 })
		expect(refusal(() => accessPrincipal(state, flip(access)))).toEqual({ message: "bad token signature", status: 401 })
		expect(refusal(() => accessPrincipal(state, refresh)).message).toBe("not an access token")
		const odd = signJwt(state.auth.secret, { exp: T0 / 1000 + 60, role: "root", sub: "x", typ: "access" })
		expect(refusal(() => accessPrincipal(state, odd)).message).toBe("malformed token claims")
		now.ms = T0 + 3600 * 1000
		expect(refusal(() => accessPrincipal(state, access))).toEqual({ message: "token expired", status: 401 })
	})

	it("accepts a bad signature under TOKEN_NOT_VERIFIED, its claims taken as given", async () => {
		const { state } = await world({ defects: ["TOKEN_NOT_VERIFIED"] })
		expect(accessPrincipal(state, flip(issueSession(state, BETA).access_token)).key).toBe("key_beta")
	})

	it("refuses a revoked token, one of a revoked family and one of a killed subject; REVOKED_TOKEN_ACCEPTED keeps the first two", async () => {
		for (const defects of [[], ["REVOKED_TOKEN_ACCEPTED"]]) {
			const { state } = await world({ defects })
			const revoked = issueSession(state, ALPHA).access_token
			const family = issueSession(state, ALPHA).access_token
			state.auth.revoked.add(String(decodeJwt(state.auth.secret, revoked)?.claims["jti"]))
			state.auth.revokedFamilies.add(String(decodeJwt(state.auth.secret, family)?.claims["fam"]))
			const outcome = (token: string): string => {
				try {
					return accessPrincipal(state, token).key
				} catch (error) {
					return (error as HttpError).message
				}
			}
			const expected = defects.length > 0 ? "key_alpha" : "token revoked"
			expect([revoked, family].map(outcome)).toEqual([expected, expected])
			state.auth.killed.add("key_alpha")
			expect(refusal(() => accessPrincipal(state, issueSession(state, ALPHA).access_token)).status).toBe(401)
		}
	})
})

describe("rotate", () => {
	it("rotates both tokens within the family, and reuse of a rotated refresh token revokes the family", async () => {
		const { state } = await world()
		const first = issueSession(state, ALPHA)
		const second = rotate(state, first.refresh_token)
		expect(decodeJwt(state.auth.secret, second.access_token)?.claims).toMatchObject({ fam: "fam_1", sub: "key_alpha" })
		expect(accessPrincipal(state, second.access_token).key).toBe("key_alpha")
		expect(refusal(() => rotate(state, first.refresh_token))).toEqual({
			message: "refresh token reused; its session is revoked",
			status: 401,
		})
		expect(refusal(() => accessPrincipal(state, second.access_token)).message).toBe("token revoked")
		expect(refusal(() => rotate(state, second.refresh_token)).message).toBe("token revoked")
		expect(refusal(() => rotate(state, second.access_token)).message).toBe("not a refresh token")
	})

	it("lets a rotated refresh token refresh again under REFRESH_REUSE_ACCEPTED", async () => {
		const { state } = await world({ defects: ["REFRESH_REUSE_ACCEPTED"] })
		const first = issueSession(state, ALPHA)
		rotate(state, first.refresh_token)
		expect(accessPrincipal(state, rotate(state, first.refresh_token).access_token).key).toBe("key_alpha")
	})
})

describe("revokeJwt", () => {
	it("revokes the caller's own access or refresh token", async () => {
		const { state } = await world()
		const session = issueSession(state, ALPHA)
		const caller = accessPrincipal(state, issueSession(state, ALPHA).access_token)
		revokeJwt(state, caller, session.access_token)
		revokeJwt(state, caller, session.refresh_token)
		expect(refusal(() => accessPrincipal(state, session.access_token)).message).toBe("token revoked")
		expect(refusal(() => rotate(state, session.refresh_token)).message).toBe("token revoked")
	})

	it("refuses a token the server did not sign with a 400, and another subject's with a 403", async () => {
		const { state } = await world()
		const caller = accessPrincipal(state, issueSession(state, ALPHA).access_token)
		const theirs = issueSession(state, BETA).access_token
		expect(refusal(() => revokeJwt(state, caller, "garbage")).status).toBe(400)
		expect(refusal(() => revokeJwt(state, caller, flip(theirs))).status).toBe(400)
		expect(refusal(() => revokeJwt(state, caller, theirs))).toEqual({
			message: "the token belongs to another principal",
			status: 403,
		})
	})
})

describe("killAll", () => {
	it("refuses every account's tokens from then on, re-issued ones included", async () => {
		const { state } = await world()
		killAll(state.auth)
		for (const account of PRINCIPALS) {
			expect(refusal(() => accessPrincipal(state, issueSession(state, account).access_token)).message).toBe(
				"token revoked",
			)
		}
	})
})
