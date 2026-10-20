import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { signsUp, signupOf } from "./signup.ts"

const SIGNUP = { method: "post", operationId: "auth.register", path: "/v1/auth/register" }
const login = (...steps: [AuthStep, ...AuthStep[]]): Partial<Recipe> => ({ login: { from: "$.t", steps } })
const mail: AuthStep = { outOfBand: { address: "{principal.email}", as: "code", kind: "otp" } }

describe("signsUp", () => {
	it("finds the signup among a login's steps, by operationId or by a raw step to its method and path", () => {
		expect(signsUp(login({ operationId: "auth.csrf" }, { operationId: "auth.register" }), SIGNUP)).toBe(true)
		expect(signsUp(login(mail, { method: "POST", path: "/v1/auth/register" }), SIGNUP)).toBe(true)
	})

	it("finds none on another route, another origin, another kind of recipe, or when the document marks none", () => {
		expect(signsUp(login({ operationId: "auth.login" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ method: "GET", path: "/v1/auth/register" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ method: "POST", path: "/v1/auth/login" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ operationId: "auth.register", origin: "idp" }), SIGNUP)).toBe(false)
		expect(signsUp(login(mail), SIGNUP)).toBe(false)
		expect(signsUp({ static: "s" }, SIGNUP)).toBe(false)
		expect(signsUp(login({ operationId: "auth.register" }), undefined)).toBe(false)
	})
})

describe("signupOf", () => {
	it("is the operation the document marks x-fresh-principal, and nothing when none is marked", () => {
		const register = { freshPrincipal: true, method: "post", operationId: "auth.register", path: "/register" }
		const read = { freshPrincipal: false, method: "get", operationId: "me.read", path: "/me" }
		expect(signupOf({ operations: [read, register] } as never)).toEqual({
			signup: { method: "post", operationId: "auth.register", path: "/register" },
		})
		expect(signupOf({ operations: [read] } as never)).toEqual({})
	})
})
