import { describe, expect, it } from "vitest"
import type { PrincipalAuth } from "../config/types/principals.ts"
import { isAuthFlow, isHookAuth } from "./auth-kind.ts"

const flow: PrincipalAuth = { credentialFrom: "$.access_token", steps: [{ operationId: "auth.token" }] }
const hook: PrincipalAuth = { fromHook: "alpha" }

describe("auth kind", () => {
	it("tells a hook from a flow", () => {
		expect([isHookAuth(hook), isAuthFlow(hook)]).toEqual([true, false])
		expect([isHookAuth(flow), isAuthFlow(flow)]).toEqual([false, true])
	})

	it("does not take a flow that also names a hook for a hook", () => {
		const both = { fromHook: "alpha", steps: [] } as unknown as PrincipalAuth
		expect([isHookAuth(both), isAuthFlow(both)]).toEqual([false, true])
	})

	it("does not take a non-string fromHook for a hook", () => {
		expect(isHookAuth({ fromHook: 1 } as unknown as PrincipalAuth)).toBe(false)
	})
})
