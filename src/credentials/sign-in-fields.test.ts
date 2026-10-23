import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import { signInFields } from "./sign-in-fields.ts"

const sorted = (fields: ReadonlySet<string>): string[] => [...fields].toSorted()

describe("signInFields", () => {
	it("names each identity key a login step reads and the field it sends it under", () => {
		const recipe: Partial<Recipe> = {
			login: {
				from: "$.token",
				steps: [
					{ body: { user: { handle: "{principal.email}" }, secret: "{principal.password}" }, operationId: "login" },
				],
			},
		}
		expect(sorted(signInFields(recipe))).toEqual(["email", "handle", "password", "secret"])
	})

	it("reads every part a step sends or binds, and an out-of-band address", () => {
		const recipe: Partial<Recipe> = {
			login: {
				from: "$.token",
				steps: [
					{ bind: { who: "{principal.login}" }, method: "POST", path: "/users/{principal.uid}/session" },
					{ headers: { "x-user": "{principal.name}" }, operationId: "otp", query: { tenant: "{principal.org}" } },
					{ outOfBand: { address: "{principal.inbox}", as: "code", kind: "email" } },
				],
			},
		}
		expect(sorted(signInFields(recipe))).toEqual(["inbox", "login", "name", "org", "tenant", "uid", "who", "x-user"])
	})

	it("reads a refresh's steps, a mint's body and an oauth2 grant's fields", () => {
		const refresh = { from: "$.token", steps: [{ body: { device: "{principal.device}" }, operationId: "renew" }] }
		const minted: Partial<Recipe> = {
			mint: { body: { owner: "{principal.uid}" }, from: "$.key", operationId: "keys", with: "jwt" },
		}
		const oauth: Partial<Recipe> = {
			oauth2: { clientId: "c", flow: "password", password: "{principal.password}", username: "{principal.email}" },
		}
		expect(sorted(signInFields({ ...minted, refresh } as Partial<Recipe>))).toEqual(["device", "owner", "uid"])
		expect(sorted(signInFields(oauth))).toEqual(["email", "password", "username"])
	})

	it("names nothing for a recipe that reads no identity", () => {
		expect(signInFields({ static: "token" }).size).toBe(0)
		expect(signInFields({ hook: true }).size).toBe(0)
		const literal: Partial<Recipe> = {
			login: { from: "$.t", steps: [{ body: ["{principal.k}", 1], operationId: "l" }] },
		}
		/* A key in an array has no field name of its own. */
		expect(sorted(signInFields(literal))).toEqual(["k"])
	})
})
