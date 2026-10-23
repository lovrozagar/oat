import { describe, expect, it } from "vitest"
import type { DefectName } from "../defects/table.ts"
import { ALPHA, api, MEMBER, TABLES, VIEWER } from "./__fixtures__/api.ts"
import type { ReferenceOptions } from "./state.ts"

const as = (authorization: string) => ({ headers: { authorization }, token: null })

/* The status the probe gets from a clean reference, then from one with `defect`. */
async function contrast(
	defect: DefectName,
	probe: (world: Awaited<ReturnType<typeof api>>) => Promise<number>,
	options: ReferenceOptions = {},
): Promise<[number, number]> {
	return [await probe(await api(options)), await probe(await api({ ...options, defects: [defect] }))]
}

/* A JWT pair for `key`, signed in through auth.token. */
async function session(world: Awaited<ReturnType<typeof api>>, key = "key_alpha") {
	return (await world.call("POST", "/v1/auth/token", { body: { key }, token: null })).body as Record<string, string>
}

/* A key minted by `token`'s principal, holding `scopes`. */
async function minted(world: Awaited<ReturnType<typeof api>>, scopes: string[], token = ALPHA) {
	return (await world.call("POST", "/v1/api-keys", { body: { scopes }, token })).body as Record<string, string>
}

describe("the credential defects, each through the router against a clean reference", () => {
	it("AUTH_IGNORED_ON_ROUTE: the notices listing answers with no credential", async () => {
		const statuses = await contrast("AUTH_IGNORED_ON_ROUTE", (w) =>
			w.call("GET", "/v1/notices", { token: null }).then((a) => a.status),
		)
		expect(statuses).toEqual([401, 200])
	})

	it("TOKEN_NOT_VERIFIED: a JWT with its signature altered authenticates", async () => {
		const statuses = await contrast("TOKEN_NOT_VERIFIED", async (w) => {
			const token = (await session(w))["access_token"] as string
			const forged = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`
			return (await w.call("GET", TABLES, as(`Bearer ${forged}`))).status
		})
		expect(statuses).toEqual([401, 200])
	})
})

describe("the scheme and scope defects, each through the router against a clean reference", () => {
	it("ANY_SCHEME_ACCEPTED: the jwt-only profile read takes an API key", async () => {
		const statuses = await contrast("ANY_SCHEME_ACCEPTED", async (w) => {
			const { key } = await minted(w, ["table:read"])
			return (await w.call("GET", "/v1/me", as(`ApiKey ${key as string}`))).status
		})
		expect(statuses).toEqual([401, 200])
	})

	it("SCOPE_NOT_CHECKED: a key holding only row:read lists tables", async () => {
		const statuses = await contrast("SCOPE_NOT_CHECKED", async (w) => {
			const { key } = await minted(w, ["row:read"])
			return (await w.call("GET", TABLES, as(`ApiKey ${key as string}`))).status
		})
		expect(statuses).toEqual([403, 200])
	})

	it("APIKEY_ALTERNATIVE_BROKEN: a record route documented jwt OR apiKey refuses a valid scoped key", async () => {
		const statuses = await contrast("APIKEY_ALTERNATIVE_BROKEN", async (w) => {
			const { key } = await minted(w, ["table:read"])
			return (await w.call("GET", TABLES, as(`ApiKey ${key as string}`))).status
		})
		expect(statuses).toEqual([200, 401])
	})

	it("PUBLIC_ROUTE_GUARDED: the public auth.login demands a credential", async () => {
		const statuses = await contrast("PUBLIC_ROUTE_GUARDED", async (w) => {
			const body = { email: "alpha@reference.test", password: "alpha-password" }
			return (await w.call("POST", "/v1/auth/login", { body, token: null })).status
		})
		expect(statuses).toEqual([200, 401])
	})
})

describe("the session defects, each through the router against a clean reference", () => {
	it("REVOKED_TOKEN_ACCEPTED: a revoked API key and a logged-out JWT keep working", async () => {
		const statuses = await contrast("REVOKED_TOKEN_ACCEPTED", async (w) => {
			const { id, key } = await minted(w, ["table:read"])
			await w.call("DELETE", `/v1/api-keys/${id as string}`)
			const { access_token: token } = await session(w)
			await w.call("POST", "/v1/logout", as(`Bearer ${token as string}`))
			const byKey = (await w.call("GET", TABLES, as(`ApiKey ${key as string}`))).status
			const byJwt = (await w.call("GET", TABLES, as(`Bearer ${token as string}`))).status
			return byKey * 1000 + byJwt
		})
		expect(statuses).toEqual([401_401, 200_200])
	})

	it("REFRESH_REUSE_ACCEPTED: a rotated refresh token refreshes again", async () => {
		const statuses = await contrast("REFRESH_REUSE_ACCEPTED", async (w) => {
			const { refresh_token: spent } = await session(w)
			const refresh = { body: { refresh_token: spent }, token: null }
			await w.call("POST", "/v1/auth/refresh", refresh)
			return (await w.call("POST", "/v1/auth/refresh", refresh)).status
		})
		expect(statuses).toEqual([401, 200])
	})
})

describe("the role, tenant and privilege defects, each through the router against a clean reference", () => {
	it("ROLE_NOT_CHECKED: a viewer creates a table", async () => {
		const statuses = await contrast("ROLE_NOT_CHECKED", (w) =>
			w.call("POST", TABLES, { body: { name: "by viewer" }, token: VIEWER }).then((a) => a.status),
		)
		expect(statuses).toEqual([403, 201])
	})

	it("CROSS_TENANT_KEY_ACCEPTED: beta's scoped key lists alpha's tables", async () => {
		const statuses = await contrast("CROSS_TENANT_KEY_ACCEPTED", async (w) => {
			const { key } = await minted(w, ["table:read"], "key_beta")
			return (await w.call("GET", TABLES, as(`ApiKey ${key as string}`))).status
		})
		expect(statuses).toEqual([403, 200])
	})

	it("PRIVILEGED_FIELD_WRITABLE: a member's update sets the table's verified flag", async () => {
		const statuses = await contrast("PRIVILEGED_FIELD_WRITABLE", async (w) => {
			const item = `${TABLES}/${String((await w.table("t"))["id"])}`
			await w.call("PATCH", item, { body: { verified: true }, token: MEMBER })
			return (await w.call("GET", item)).body["verified"] === true ? 1 : 0
		})
		expect(statuses).toEqual([0, 1])
	})

	it("PRIVILEGED_FIELD_ON_SIGNUP: a sign-up that asks for the staff flag gets it", async () => {
		const statuses = await contrast("PRIVILEGED_FIELD_ON_SIGNUP", async (w) => {
			await w.call("POST", "/v1/register", { body: { email: "s@x.test", staff: true }, token: null })
			const [made] = (await w.call("GET", "/v1/signups")).body["signups"] as Array<{ staff: boolean }>
			return made?.staff === true ? 1 : 0
		})
		expect(statuses).toEqual([0, 1])
	})

	it("LOGIN_NOT_THROTTLED: under throttleLogins, the sixth failed login is not a 429", async () => {
		const statuses = await contrast(
			"LOGIN_NOT_THROTTLED",
			async (w) => {
				const wrong = { body: { key: "key_nobody" }, token: null }
				for (let attempt = 0; attempt < 5; attempt += 1) await w.call("POST", "/v1/auth/token", wrong)
				return (await w.call("POST", "/v1/auth/token", wrong)).status
			},
			{ throttleLogins: true },
		)
		expect(statuses).toEqual([429, 401])
	})
})
