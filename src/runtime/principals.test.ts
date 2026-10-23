import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { HeldCredential } from "../credentials/store.ts"
import { Redactor } from "../security/redact.ts"
import { keptCredentials, loadPersistedPrincipals, parsePersistedPrincipals, snapshotPrincipal } from "./principals.ts"

const sends = { cookies: {}, headers: { Authorization: "Bearer secret-1" }, query: {} }
const secrets = { cookies: [], headers: ["Authorization"], query: [], values: ["secret-1"] }
const NONE = new Redactor()
const HELD: HeldCredential[] = [
	{ credential: { expiresAt: 5000, secrets, sends, value: "secret-1" }, principal: "alpha", scheme: "jwt", scopes: [] },
	{
		credential: { expiresAt: null, scopes: ["a"], secrets, sends, value: "key-1" },
		principal: "alpha",
		scheme: "key",
		scopes: ["a"],
	},
	{ credential: { expiresAt: null, secrets, sends, value: "beta-1" }, principal: "beta", scheme: "jwt", scopes: [] },
]

describe("snapshotPrincipal", () => {
	it("keeps identity, tenant, rank, scope and each credential's expiry, never a credential value", () => {
		const snap = snapshotPrincipal(
			{
				id: "alpha",
				identity: { email: "a@x.test" },
				inviteAs: "a@x.test",
				rank: 2,
				scope: { project_id: "p1" },
				tenant: "t1",
			},
			{ held: HELD, redactor: NONE },
		)
		expect(snap).toEqual({
			credentials: [
				{ expiresAt: 5000, scheme: "jwt", scopes: [] },
				{ expiresAt: null, scheme: "key", scopes: ["a"] },
			],
			id: "alpha",
			identity: { email: "a@x.test" },
			inviteAs: "a@x.test",
			rank: 2,
			scope: { project_id: "p1" },
			tenant: "t1",
		})
		expect(JSON.stringify(snap)).not.toMatch(/secret-1|key-1/)
	})

	it("says why a principal the run could not sign in was BLOCKED", () => {
		const reason = "login for beta/jwt: auth step 1 answered 401"
		expect(
			snapshotPrincipal(
				{ blocked: reason, id: "beta", identity: {}, rank: 0, scope: {} },
				{ held: HELD, redactor: NONE },
			),
		).toEqual({
			blocked: reason,
			credentials: [{ expiresAt: null, scheme: "jwt", scopes: [] }],
			id: "beta",
			identity: {},
			rank: 0,
			scope: {},
		})
	})

	it("omits a tenant and an invite value it does not have", () => {
		expect(snapshotPrincipal({ id: "solo", identity: {}, rank: 0, scope: {} }, { held: [], redactor: NONE })).toEqual({
			credentials: [],
			id: "solo",
			identity: {},
			rank: 0,
			scope: {},
		})
	})
})

describe("snapshotPrincipal identity", () => {
	it("drops every credential-named identity key and every value the run holds as a secret", () => {
		const redactor = new Redactor()
		redactor.registerSecret("pin-123456")
		const identity = {
			api_key: "k-1",
			apiKey: "k-2",
			email: "a@x.test",
			name: "Alpha",
			password: "alpha-password",
			pin: "pin-123456",
			profile: { clientSecret: "s-1", team: "red" },
			refreshToken: "r-1",
			secret: "s-2",
			token: "t-1",
		}
		const snap = snapshotPrincipal({ id: "alpha", identity, rank: 0, scope: {} }, { held: [], redactor })
		expect(snap.identity).toEqual({ email: "a@x.test", name: "Alpha", profile: { team: "red" } })
		expect(JSON.stringify(snap)).not.toMatch(/alpha-password|pin-123456|k-1|k-2|s-1|s-2|r-1|t-1/)
	})
})

describe("keptCredentials", () => {
	it("lists every held value, for --keep-credentials alone", () => {
		expect(keptCredentials(HELD)).toEqual([
			{ expiresAt: 5000, principal: "alpha", scheme: "jwt", scopes: [], value: "secret-1" },
			{ expiresAt: null, principal: "alpha", scheme: "key", scopes: ["a"], value: "key-1" },
			{ expiresAt: null, principal: "beta", scheme: "jwt", scopes: [], value: "beta-1" },
		])
	})
})

describe("parsePersistedPrincipals", () => {
	it("reads { principals } and a bare array back into the config's principals map", () => {
		const one = parsePersistedPrincipals(
			JSON.stringify({
				principals: [
					{
						credentials: [{ expiresAt: 1, scheme: "jwt", scopes: [] }],
						id: "a",
						identity: { email: "a@x.test", key: "key_a" },
						inviteAs: "b@x.test",
						rank: 2,
						scope: { project_id: "1", skip: 9 },
						tenant: "t1",
					},
				],
			}),
		)
		expect(one).toEqual({
			a: { email: "a@x.test", inviteAs: "b@x.test", key: "key_a", rank: 2, scope: { project_id: "1" }, tenant: "t1" },
		})
		expect(parsePersistedPrincipals(JSON.stringify([{ id: "b" }]))).toEqual({ b: { scope: {} } })
	})

	it("never lets identity data stand in for how a principal is graded or authenticates", () => {
		const parsed = parsePersistedPrincipals(
			JSON.stringify([
				{
					id: "a",
					identity: { fresh: true, rank: 9, scope: { x: "y" }, security: { jwt: { static: "s" } }, tenant: "z" },
				},
			]),
		)
		expect(parsed).toEqual({ a: { scope: {} } })
	})

	it("skips unusable entries and fields of the wrong type", () => {
		const parsed = parsePersistedPrincipals(
			JSON.stringify([
				null,
				3,
				{ id: "" },
				{ id: 4 },
				{ id: "c", identity: [1], inviteAs: 1, rank: "2", scope: [], tenant: 7 },
			]),
		)
		expect(parsed).toEqual({ c: { scope: {} } })
	})

	it("refuses text that is not JSON, the wrong shape, or no usable principal", () => {
		expect(() => parsePersistedPrincipals("{", "p.json")).toThrow("oat: p.json is not valid JSON")
		expect(() => parsePersistedPrincipals("{}")).toThrow(
			"oat: principals.json must be { principals: [...] } or an array of principals",
		)
		expect(() => parsePersistedPrincipals("7")).toThrow("must be { principals: [...] }")
		expect(() => parsePersistedPrincipals("[]")).toThrow("oat: principals.json contains no usable principals")
	})
})

describe("loadPersistedPrincipals", () => {
	it("reads a file synchronously, so a config can call it at module load", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-principals-"))
		const path = join(dir, "principals.json")
		await writeFile(path, JSON.stringify({ principals: [{ id: "a", identity: { key: "k" }, rank: 1 }] }))
		expect(loadPersistedPrincipals(path)).toEqual({ a: { key: "k", rank: 1, scope: {} } })
		expect(() => loadPersistedPrincipals(join(dir, "missing.json"))).toThrow(
			"oat: cannot read persisted principals from",
		)
	})
})
