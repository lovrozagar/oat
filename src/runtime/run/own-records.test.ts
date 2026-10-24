import { describe, expect, it, vi } from "vitest"
import type { RunContext } from "./context.ts"
import { ownRecordsOf } from "./own-records.ts"
import { emptyState } from "./state.ts"

/* The run's guard over its principals' own records: one per run, built from its recipes and principals. */

const enrolled = vi.hoisted(() => ({ asked: [] as string[], blocked: undefined as string | undefined }))

vi.mock("./disposable.ts", () => ({
	enrollerOf: () => async (label: string) => {
		enrolled.asked.push(label)
		return enrolled.blocked === undefined ? { id: `disposable-${label}` } : { blocked: enrolled.blocked }
	},
}))

const LOGIN = {
	from: "$.token",
	steps: [{ body: { email: "{principal.email}", secret: "{principal.password}" }, operationId: "auth.login" }],
}

function contextOf(): RunContext {
	const principals = { alpha: { email: "ann@x.io", password: "p" } }
	return {
		options: { security: { jwt: { login: LOGIN } } },
		principals: { byId: new Map([["alpha", { identity: principals.alpha }]]) },
		state: emptyState(),
		store: { principals },
	} as unknown as RunContext
}

describe("ownRecordsOf", () => {
	it("is one guard per run: what the recipes sign in with, and whose records it guards", () => {
		const ctx = contextOf()
		const records = ownRecordsOf(ctx)
		expect(ownRecordsOf(ctx)).toBe(records)
		expect(records.signIn).toEqual(new Set(["email", "password", "secret"]))
		expect(records.identityOf("alpha")).toEqual({ email: "ann@x.io", password: "p" })
		expect(records.identityOf("alpha#probe-1")).toEqual({ email: "ann@x.io", password: "p" })
		records.learn?.("alpha", { id: "u-1" })
		expect(records.identityOf("alpha")).toEqual({ email: "ann@x.io", id: "u-1", password: "p" })
		expect(records.identityOf("disposable-own-record")).toBeUndefined()
	})

	it("signs up its disposable principal once, on the first write that needs it", async () => {
		const records = ownRecordsOf(contextOf())
		expect(enrolled.asked).toEqual([])
		expect(await records.disposable()).toBe("disposable-own-record")
		expect(await records.disposable()).toBe("disposable-own-record")
		expect(enrolled.asked).toEqual(["own-record"])
	})

	it("hands back why the disposable principal could not sign up", async () => {
		enrolled.blocked = "the document marks no x-fresh-principal operation"
		expect(await ownRecordsOf(contextOf()).disposable()).toEqual({ blocked: enrolled.blocked })
		enrolled.blocked = undefined
	})
})

describe("ownRecordsOf and the credentials the run holds", () => {
	it("knows each record a mint recipe made, from what the credential store sent", () => {
		const create = { createdIdFrom: null, entity: "api-key", operationId: "apiKey.create", recordPath: null }
		const minted = {
			issuedBy: "credentials",
			operationId: "apiKey.create",
			responseBody: { id: "k-1", key: "ak_1" },
			responseHeaders: {},
			status: 201,
			url: "http://api.test/keys",
		}
		const ctx = {
			...contextOf(),
			client: { exchangesFor: (id: string) => (id === "apiKey.create" ? [minted] : []) },
			model: {
				byOperationId: new Map([["apiKey.create", create]]),
				entities: new Map([["api-key", { identity: "id", name: "api-key" }]]),
			},
			options: {
				security: {
					apiKey: { mint: { from: "$.key", operationId: "apiKey.create", with: "jwt" } },
					jwt: { login: LOGIN },
				},
			},
		} as unknown as RunContext
		expect(ownRecordsOf(ctx).credentials?.()).toEqual([{ entity: "api-key", id: "k-1", operationId: "apiKey.create" }])
	})
})
