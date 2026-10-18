import { afterEach, describe, expect, it, vi } from "vitest"
import { isNetworkError, NetworkError } from "../../errors/network.ts"
import { fetchSpecText, fetchWithNetworkRetry, type NetworkFetchOptions } from "./fetch.ts"

/* ERR_INTERNET_DISCONNECTED reads as "offline", which no interface check can refine further. */
const offline = (): Error =>
	Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_INTERNET_DISCONNECTED" } })

type Impl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Answers from a script: an Error entry is thrown, a Response is returned, in order. */
function scripted(...script: Array<Response | Error>): ReturnType<typeof vi.fn<Impl>> {
	return vi.fn<Impl>(async () => {
		const next = script.shift()
		if (next === undefined) throw new Error("script ran out")
		if (next instanceof Error) throw next
		return next
	})
}

/** Sleeps that only move a virtual clock. */
function clock(): Required<Pick<NetworkFetchOptions, "now" | "sleep">> & { slept: number[] } {
	let at = 0
	const slept: number[] = []
	return {
		now: () => at,
		sleep: async (ms) => {
			slept.push(ms)
			at += ms
		},
		slept,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("fetchWithNetworkRetry, answered", () => {
	it("returns the first answer, sending the request as given", async () => {
		const impl = scripted(new Response("ok"))
		const init = { method: "post" }
		const res = await fetchWithNetworkRetry("http://h.test/a", init, { fetchImpl: impl })
		expect(await res.text()).toBe("ok")
		expect(impl.mock.calls[0]).toEqual(["http://h.test/a", init])
	})

	it("adds a timeout signal per attempt when one is set", async () => {
		const impl = scripted(new Response("ok"))
		await fetchWithNetworkRetry("http://h.test/a", { method: "GET" }, { fetchImpl: impl, requestTimeoutMs: 50 })
		const sent = impl.mock.calls[0]?.[1] as RequestInit
		expect([sent.method, sent.signal instanceof AbortSignal]).toEqual(["GET", true])
	})

	it("rethrows a failure that is not the network's, without retrying", async () => {
		const boom = new Error("boom")
		const impl = scripted(boom)
		await expect(fetchWithNetworkRetry("http://h.test/a", {}, { fetchImpl: impl })).rejects.toBe(boom)
		expect(impl).toHaveBeenCalledTimes(1)
	})

	it("retries a network blip after the backoff, and uses fetch and GET by default", async () => {
		const time = clock()
		const global = scripted(offline(), new Response("ok"))
		vi.stubGlobal("fetch", global)
		const res = await fetchWithNetworkRetry("http://h.test/a", undefined, { sleep: time.sleep })
		expect(await res.text()).toBe("ok")
		expect(time.slept).toEqual([250])
		await expect(fetchWithNetworkRetry("http://h.test/b")).rejects.toThrow("script ran out")
	})
})

describe("fetchWithNetworkRetry, out of retries", () => {
	it("names the failure and how long it waited once the link never came back", async () => {
		const time = clock()
		const impl = scripted(offline(), offline(), offline())
		const error = await fetchWithNetworkRetry(
			"http://h.test/a",
			{ method: "delete" },
			{
				...time,
				fetchImpl: impl,
				onWait: () => undefined,
				probe: async () => false,
				retries: 2,
				waitMs: 2_000,
			},
		).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(NetworkError)
		const failed = error as NetworkError
		expect([failed.kind, failed.attempts, failed.method, failed.url]).toEqual([
			"offline",
			3,
			"DELETE",
			"http://h.test/a",
		])
		expect(failed.message).toContain("and 2s waiting for the link")
		expect(isNetworkError(failed.cause)).toBe(true)
		expect(time.slept).toEqual([250, 500, 2_000])
	})

	it("asks once more when the link comes back", async () => {
		const time = clock()
		const impl = scripted(offline(), new Response("back"))
		const res = await fetchWithNetworkRetry(
			"http://h.test/a",
			{},
			{ ...time, fetchImpl: impl, probe: async () => true, retries: -3, waitMs: 5_000 },
		)
		expect(await res.text()).toBe("back")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	it("probes the origin with the same fetch, for a minute, when no probe or wait is given", async () => {
		const time = clock()
		const impl = scripted(offline(), new Response(null), offline())
		const error = await fetchWithNetworkRetry("http://h.test/a", {}, { ...time, fetchImpl: impl, retries: 0 }).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(NetworkError)
	})
})

describe("fetchSpecText", () => {
	it("reads the document, asking for JSON, without waiting for the link", async () => {
		const impl = scripted(new Response('{"openapi":"3.1.0"}'))
		expect(await fetchSpecText("http://h.test/spec", { fetchImpl: impl })).toBe('{"openapi":"3.1.0"}')
		expect((impl.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({ accept: "application/json" })
		const down = scripted(offline())
		await expect(fetchSpecText("http://h.test/spec", { fetchImpl: down, retries: 0 })).rejects.toBeInstanceOf(
			NetworkError,
		)
	})

	it("refuses an answer that is not a success, and uses fetch by default", async () => {
		vi.stubGlobal("fetch", scripted(new Response("gone", { status: 404, statusText: "Not Found" })))
		await expect(fetchSpecText("http://h.test/spec")).rejects.toThrow(
			"oat: fetching http://h.test/spec returned 404 Not Found",
		)
	})
})
