import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { signsUp } from "./signup.ts"

const SIGNUP = [{ method: "post", operationId: "auth.register", path: "/v1/auth/register" }]
const login = (...steps: [AuthStep, ...AuthStep[]]): Partial<Recipe> => ({ login: { from: "$.t", steps } })
const mail: AuthStep = { outOfBand: { address: "{principal.email}", as: "code", kind: "otp" } }

describe("signsUp", () => {
	it("finds any one of several account makers", () => {
		const makers = [{ method: "post", operationId: "auth.signup", path: "/signup" }, ...SIGNUP]
		expect(signsUp(login({ operationId: "auth.register" }), makers)).toBe(true)
	})

	it("finds the signup among a login's steps, by operationId or by a raw step to its method and path", () => {
		expect(signsUp(login({ operationId: "auth.csrf" }, { operationId: "auth.register" }), SIGNUP)).toBe(true)
		expect(signsUp(login(mail, { method: "POST", path: "/v1/auth/register" }), SIGNUP)).toBe(true)
	})

	it("finds none on another route, another origin, another kind of recipe, or when the document makes no account", () => {
		expect(signsUp(login({ operationId: "auth.login" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ method: "GET", path: "/v1/auth/register" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ method: "POST", path: "/v1/auth/login" }), SIGNUP)).toBe(false)
		expect(signsUp(login({ operationId: "auth.register", origin: "idp" }), SIGNUP)).toBe(false)
		expect(signsUp(login(mail), SIGNUP)).toBe(false)
		expect(signsUp({ static: "s" }, SIGNUP)).toBe(false)
		expect(signsUp(login({ operationId: "auth.register" }), [])).toBe(false)
	})
})
