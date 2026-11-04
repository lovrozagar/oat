import { describe, expect, it } from "vitest"
import { peerOf } from "./peer.ts"

type Who = { id: string; tenant?: string }

const alpha: Who = { id: "alpha", tenant: "t1" }
const admin: Who = { id: "admin" }
const beta: Who = { id: "beta", tenant: "t2" }

describe("peerOf", () => {
	it("crosses into the first principal of another tenant, past one that holds no tenant", () => {
		expect(peerOf([alpha, admin, beta])).toBe(beta)
		expect(peerOf([alpha, beta, admin])).toBe(beta)
	})

	it("finds none among one tenant and principals that hold none", () => {
		expect(peerOf([alpha, admin, { id: "gamma", tenant: "t1" } satisfies Who])).toBeUndefined()
	})

	it("crosses from a principal with no tenant into the first that holds one", () => {
		expect(peerOf([admin, alpha, beta])).toBe(alpha)
	})
})
