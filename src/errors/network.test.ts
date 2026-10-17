import { describe, expect, it } from "vitest"
import {
	classifyNetworkError,
	describeNetworkFailure,
	describeNetworkKind,
	isNetworkError,
	NetworkError,
	type NetworkKind,
} from "./network.ts"

const coded = (code: string, cause?: unknown): Error => Object.assign(new Error("fetch failed", { cause }), { code })

describe("classifyNetworkError", () => {
	it("names each kind from an error code anywhere on the cause chain", () => {
		const cases: Array<[unknown, NetworkKind]> = [
			[coded("ENONET"), "offline"],
			[coded("EHOSTUNREACH"), "unreachable"],
			[new Error("fetch failed", { cause: coded("ENOTFOUND") }), "dns"],
			[coded("ECONNREFUSED"), "refused"],
			[coded("ECONNRESET"), "reset"],
			[Object.assign(new Error("slow"), { name: "TimeoutError" }), "timeout"],
			[new Error("socket hang up"), "unknown"],
			["getaddrinfo failed", "unknown"],
		]
		expect(cases.map(([error]) => classifyNetworkError(error))).toEqual(cases.map(([, kind]) => kind))
	})

	it("is not a network failure when TLS or the URL is at fault, or nothing matches", () => {
		expect(classifyNetworkError(coded("ERR_TLS_CERT_ALTNAME_INVALID"))).toBeNull()
		expect(classifyNetworkError(new Error("bad json"))).toBeNull()
		expect(classifyNetworkError(null)).toBeNull()
		expect(classifyNetworkError({ code: "", message: "" })).toBeNull()
	})

	it("stops on a cause chain that loops", () => {
		const looped: { cause?: unknown; code: string } = { code: "ECONNRESET" }
		looped.cause = looped
		expect(classifyNetworkError(looped)).toBe("reset")
	})
})

describe("network failures, described", () => {
	const error = new NetworkError({ attempts: 3, kind: "dns", message: "no", method: "GET", url: "https://x.test/a" })

	it("says what each kind means", () => {
		const kinds: NetworkKind[] = ["offline", "dns", "refused", "reset", "timeout", "unreachable", "unknown"]
		expect(new Set(kinds.map(describeNetworkKind)).size).toBe(kinds.length)
	})

	it("names the request, the kind, the attempts and any wait", () => {
		expect(describeNetworkFailure(error)).toBe(
			"GET https://x.test/a failed (dns: DNS could not resolve the host) after 3 attempt(s). This is not a backend status.",
		)
		expect(describeNetworkFailure(error, 4_400)).toContain("after 3 attempt(s) and 4s waiting for the link.")
	})

	it("is a NetworkError, with its cause kept", () => {
		const cause = new Error("root")
		const wrapped = new NetworkError({ attempts: 1, cause, kind: "reset", message: "m", method: "PUT", url: "u" })
		expect([isNetworkError(wrapped), isNetworkError(new Error("x")), wrapped.cause, wrapped.code]).toEqual([
			true,
			false,
			cause,
			"NETWORK",
		])
		expect(error.cause).toBeUndefined()
	})
})
