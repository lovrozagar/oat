import { describe, expect, it } from "vitest"
import type { AuthFlow } from "../../config/types/principals.ts"
import { authFlowOf, disposableAddress, freshSignupFlow, signupEmail, signupOperationId } from "./flow.ts"

const register = (step: Record<string, unknown>): AuthFlow =>
	({ credentialFrom: "$.access_token", steps: [step] }) as unknown as AuthFlow

describe("signupOperationId / authFlowOf", () => {
	it("names the first step that calls an operation, in a flow with steps", () => {
		expect(signupOperationId(undefined)).toBeUndefined()
		expect(signupOperationId({ fromHook: "oauth" } as never)).toBeUndefined()
		expect(signupOperationId(register({ method: "POST", path: "/x" }))).toBeUndefined()
		expect(
			signupOperationId({ steps: [{ outOfBand: {} }, { operationId: "auth.register" }] } as unknown as AuthFlow),
		).toBe("auth.register")
		expect(authFlowOf(undefined)).toBeNull()
		expect(authFlowOf({ fromHook: "oauth" } as never)).toBeNull()
		expect(authFlowOf({ headers: {} } as never)).toBeNull()
		const flow = register({ operationId: "auth.register" })
		expect(authFlowOf(flow)).toBe(flow)
	})
})

describe("signupEmail", () => {
	it("reads a bound address, else a body email", () => {
		expect(signupEmail(register({ bind: { address: "a@b.c" }, body: { email: "z@b.c" } }))).toBe("a@b.c")
		expect(signupEmail(register({ body: { email: "z@b.c" } }))).toBe("z@b.c")
		expect(signupEmail(register({ body: { email: 3 } }))).toBeUndefined()
		expect(signupEmail(register({ body: null }))).toBeUndefined()
		expect(signupEmail(register({ body: "text" }))).toBeUndefined()
		expect(signupEmail(register({ bind: { other: "x" }, body: { name: "n" } }))).toBeUndefined()
		expect(signupEmail(register({ bind: undefined }))).toBeUndefined()
	})
})

describe("freshSignupFlow", () => {
	it("rewrites only the signup email", () => {
		const flow = freshSignupFlow(
			{
				credentialFrom: "$.access_token",
				steps: [
					{
						bind: { address: "a@b.c" },
						body: { email: "a@b.c", password: "secret", tags: ["a@b.c", 1, null] },
						operationId: "auth.register",
					},
					{ outOfBand: { address: "a@b.c", as: "link", kind: "email-verify" } },
				],
			} as AuthFlow,
			"new@b.c",
		)
		expect(flow.steps[0]).toMatchObject({
			bind: { address: "new@b.c" },
			body: { email: "new@b.c", password: "secret", tags: ["new@b.c", 1, null] },
		})
		expect(flow.steps[1]).toMatchObject({ outOfBand: { address: "new@b.c" } })
	})

	it("copies a flow with no email, or one already at the address", () => {
		const none = register({ operationId: "auth.login" })
		expect(freshSignupFlow(none, "x@y.z")).toEqual(none)
		expect(freshSignupFlow(none, "x@y.z")).not.toBe(none)
		const same = register({ body: { email: "x@y.z" } })
		expect(freshSignupFlow(same, "x@y.z")).toEqual(same)
	})
})

describe("disposableAddress", () => {
	it("keeps the signup's domain, or uses example.test", () => {
		expect(disposableAddress(register({ body: { email: "oat-alpha@example.test" } }), "abc")).toBe(
			"oat-disp-abc@example.test",
		)
		expect(disposableAddress(register({ body: { email: "a@corp.test" } }), "n")).toBe("oat-disp-n@corp.test")
		expect(disposableAddress(register({ body: { email: "@corp.test" } }), "n")).toBe("oat-disp-n@example.test")
		expect(disposableAddress(register({ body: { email: "nobody" } }), "n")).toBe("oat-disp-n@example.test")
		expect(disposableAddress(register({}), "n")).toBe("oat-disp-n@example.test")
	})
})
