import { describe, expect, it } from "vitest"
import { memoryStore } from "../engines.ts"
import { HttpError } from "../errors.ts"
import { referenceState } from "../reference.ts"
import { PRINCIPALS, type ReferenceOptions } from "../state.ts"
import { apiKeyPrincipal, createApiKey, findApiKey, revokeApiKey } from "./api-keys.ts"
import { killAll } from "./sessions.ts"

const [ALPHA, BETA, MEMBER] = PRINCIPALS as [(typeof PRINCIPALS)[0], (typeof PRINCIPALS)[0], (typeof PRINCIPALS)[0]]
const READ = { projectId: "proj_alpha", scope: "table:read" }

const world = (options: ReferenceOptions = {}) => referenceState(options, memoryStore)

function refusal(run: () => unknown): { status: number; message: string } {
	try {
		run()
	} catch (error) {
		if (error instanceof HttpError) return { message: error.message, status: error.status }
	}
	throw new Error("no refusal")
}

describe("createApiKey", () => {
	it("binds a new ak_ key to its creator's tenant, rank and scopes, under a padded id", async () => {
		const state = await world()
		const key = createApiKey(state, MEMBER, ["table:read"])
		expect(key).toMatchObject({
			id: "apikey_000001",
			projectId: "proj_alpha",
			rank: 1,
			revoked: false,
			scopes: ["table:read"],
			sub: "key_alpha_member",
		})
		expect(key.value).toMatch(/^ak_[0-9a-f]{32}$/)
		expect(createApiKey(state, ALPHA, []).value).not.toBe(key.value)
		expect(state.auth.apiKeys.get(key.value)).toBe(key)
	})
})

describe("apiKeyPrincipal", () => {
	it("authenticates a live key within its tenant and scope as its creator's tenant and rank", async () => {
		const state = await world()
		const { value } = createApiKey(state, MEMBER, ["table:read"])
		expect(apiKeyPrincipal(state, value, READ)).toEqual({ key: "key_alpha_member", projectId: "proj_alpha", rank: 1 })
		expect(apiKeyPrincipal(state, value, { scope: "table:read" }).projectId).toBe("proj_alpha")
	})

	it("refuses an unknown key, a revoked one and a killed creator's with a 401", async () => {
		const state = await world()
		expect(refusal(() => apiKeyPrincipal(state, "ak_nope", READ))).toEqual({ message: "unknown API key", status: 401 })
		const revoked = createApiKey(state, ALPHA, ["table:read"])
		revoked.revoked = true
		expect(refusal(() => apiKeyPrincipal(state, revoked.value, READ))).toEqual({
			message: "API key revoked",
			status: 401,
		})
		const live = createApiKey(state, ALPHA, ["table:read"])
		killAll(state.auth)
		expect(refusal(() => apiKeyPrincipal(state, live.value, READ)).message).toBe("API key revoked")
	})

	it("keeps a revoked key working under REVOKED_TOKEN_ACCEPTED", async () => {
		const state = await world({ defects: ["REVOKED_TOKEN_ACCEPTED"] })
		const key = createApiKey(state, ALPHA, ["table:read"])
		key.revoked = true
		expect(apiKeyPrincipal(state, key.value, READ).key).toBe("key_alpha")
	})

	it("refuses another tenant's project with a 403, or adopts it under CROSS_TENANT_KEY_ACCEPTED", async () => {
		const strict = await world()
		const theirs = createApiKey(strict, BETA, ["table:read"])
		expect(refusal(() => apiKeyPrincipal(strict, theirs.value, READ))).toEqual({
			message: "the API key belongs to another tenant",
			status: 403,
		})
		const lax = await world({ defects: ["CROSS_TENANT_KEY_ACCEPTED"] })
		const key = createApiKey(lax, BETA, ["table:read"])
		expect(apiKeyPrincipal(lax, key.value, READ)).toEqual({ key: "key_beta", projectId: "proj_alpha", rank: 2 })
	})

	it("refuses a key without the operation's scope with a 403, unless SCOPE_NOT_CHECKED", async () => {
		const strict = await world()
		const key = createApiKey(strict, ALPHA, ["row:read"])
		expect(refusal(() => apiKeyPrincipal(strict, key.value, READ))).toEqual({
			message: 'the API key lacks the scope "table:read"',
			status: 403,
		})
		const lax = await world({ defects: ["SCOPE_NOT_CHECKED"] })
		expect(apiKeyPrincipal(lax, createApiKey(lax, ALPHA, []).value, READ).key).toBe("key_alpha")
	})

	it("takes any live key without a scope to meet, where a jwt-only route lets keys in", async () => {
		const state = await world()
		expect(apiKeyPrincipal(state, createApiKey(state, ALPHA, []).value, undefined).key).toBe("key_alpha")
	})
})

describe("revokeApiKey", () => {
	it("revokes a key of the caller's tenant, and answers 404 for an unknown id or another tenant's key", async () => {
		const state = await world()
		const mine = createApiKey(state, MEMBER, [])
		const theirs = createApiKey(state, BETA, [])
		revokeApiKey(state, ALPHA, mine.id)
		expect(mine.revoked).toBe(true)
		expect(refusal(() => revokeApiKey(state, ALPHA, theirs.id))).toEqual({
			message: `API key ${theirs.id} does not exist`,
			status: 404,
		})
		expect(refusal(() => revokeApiKey(state, ALPHA, "apikey_999999")).status).toBe(404)
		expect(theirs.revoked).toBe(false)
	})
})

describe("findApiKey", () => {
	it("finds a live key of the caller's tenant; a revoked one is gone, a 404 like an unknown id", async () => {
		const state = await world()
		const mine = createApiKey(state, ALPHA, ["table:read"])
		expect(findApiKey(state, MEMBER, mine.id)).toBe(mine)
		revokeApiKey(state, ALPHA, mine.id)
		expect(refusal(() => findApiKey(state, ALPHA, mine.id))).toEqual({
			message: `API key ${mine.id} does not exist`,
			status: 404,
		})
	})
})
