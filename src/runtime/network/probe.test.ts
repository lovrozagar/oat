import { afterEach, describe, expect, it, vi } from "vitest"
import { failing } from "./__fixtures__/failures.ts"
import { probeOrigin } from "./probe.ts"

const answering = (response: Response) => vi.fn<typeof fetch>(async () => response)
const throwing = (error: unknown) =>
	vi.fn<typeof fetch>(async () => {
		throw error
	})
const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("probeOrigin", () => {
	it("asks the origin for its head, without following redirects", async () => {
		const impl = answering(new Response(null, { status: 302 }))
		expect(await probeOrigin("http://h.test/a/b?c=1", { fetchImpl: impl, online: () => true, timeoutMs: 10 })).toBe(
			true,
		)
		const [url, init] = impl.mock.calls[0] as [string, RequestInit]
		expect([url, init.method, init.redirect, init.signal instanceof AbortSignal]).toEqual([
			"http://h.test",
			"HEAD",
			"manual",
			true,
		])
	})

	it("is down when this machine has no link, without asking", async () => {
		const impl = answering(new Response(null))
		expect(await probeOrigin("http://h.test", { fetchImpl: impl, online: () => false })).toBe(false)
		expect(impl).not.toHaveBeenCalled()
	})

	it("is down for an origin that is not a URL, and for an answer with no status", async () => {
		expect(await probeOrigin("not a url", { online: () => true })).toBe(false)
		const failed = answering(Response.error())
		expect(await probeOrigin("http://h.test", { fetchImpl: failed, online: () => true })).toBe(false)
	})

	it("is down only when the probe meets a network failure", async () => {
		expect(await probeOrigin("http://h.test", { fetchImpl: throwing(refused), online: () => true })).toBe(false)
		expect(await probeOrigin("http://h.test", { fetchImpl: throwing(new Error("boom")), online: () => true })).toBe(
			true,
		)
	})

	it("uses the global fetch and this machine's interfaces by default", async () => {
		const global = answering(new Response(null))
		vi.stubGlobal("fetch", global)
		expect(await probeOrigin("http://h.test", { online: () => true })).toBe(true)
		expect(global).toHaveBeenCalledTimes(1)
		expect(typeof (await probeOrigin("http://h.test", { fetchImpl: global }))).toBe("boolean")
	})
})

/* A fetch that fails with a programming error, not a network one. */
const bug = async (): Promise<Response> => {
	throw new SyntaxError("bug")
}

describe("probeOrigin, by what the origin answers", () => {
	it("treats a reachable host as up and a refused port as down", async () => {
		expect(await probeOrigin("http://x.test", { online: () => false })).toBe(false)
		expect(await probeOrigin("not a url")).toBe(false)
		expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 404 }) })).toBe(
			true,
		)
		expect(await probeOrigin("http://x.test", { fetchImpl: failing("ECONNREFUSED") })).toBe(false)
		expect(await probeOrigin("http://x.test", { fetchImpl: bug })).toBe(true)
		expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 204 }) })).toBe(
			true,
		)
	})
})
