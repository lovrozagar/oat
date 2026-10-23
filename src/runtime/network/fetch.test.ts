import { afterEach, describe, expect, it, vi } from "vitest"
import { isNetworkError, NetworkError } from "../../errors/network.ts"
import { failing, net } from "./__fixtures__/failures.ts"
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

const SPEC = "http://x.test/spec"

/** No-op sleeps that move a virtual clock, for a wait budget that must run out. */
function ticking(): Required<Pick<NetworkFetchOptions, "now" | "sleep">> {
	let at = 0
	return {
		now: () => at,
		sleep: async (ms) => {
			at += ms
		},
	}
}

describe("fetchWithNetworkRetry, by failure kind", () => {
	it("uses default retries, fetch, sleep, and wait budget", async () => {
		vi.stubGlobal("fetch", async () => new Response("ok"))
		expect(await (await fetchWithNetworkRetry(SPEC)).text()).toBe("ok")
		const waits: string[] = []
		await expect(
			fetchWithNetworkRetry(
				SPEC,
				{},
				{ ...ticking(), fetchImpl: failing("ECONNRESET"), onWait: (info) => waits.push(info.kind), retries: 0 },
			),
		).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "reset")
		expect(waits.length).toBeGreaterThan(0)
	})

	it("retries a blip and then succeeds", async () => {
		let hits = 0
		const sleeps: number[] = []
		const blip = async (): Promise<Response> => {
			hits += 1
			if (hits < 3) throw net("ECONNRESET")
			return new Response("ok", { status: 200 })
		}
		const sleep = async (ms: number): Promise<void> => {
			sleeps.push(ms)
		}
		const res = await fetchWithNetworkRetry(SPEC, { method: "GET" }, { fetchImpl: blip, retries: 4, sleep, waitMs: 0 })
		expect(await res.text()).toBe("ok")
		expect(hits).toBe(3)
		expect(sleeps).toEqual([250, 500])
	})

	it("waits for the link after retries, then fails with a named NetworkError", async () => {
		const options = { fetchImpl: failing("ENETUNREACH"), probe: async () => false, retries: 0, waitMs: 80 }
		await expect(fetchWithNetworkRetry(SPEC, {}, { ...options, sleep: ticking().sleep })).rejects.toSatisfy(
			(error: unknown) =>
				isNetworkError(error) &&
				error.kind === "unreachable" &&
				!error.message.includes("never") &&
				error.message.includes("not a backend"),
		)
	})
})

describe("fetchWithNetworkRetry, after the wait budget", () => {
	it("recovers after the wait budget probe succeeds", async () => {
		let hits = 0
		const flaky = async (): Promise<Response> => {
			hits += 1
			if (hits === 1) throw net("ENOTFOUND")
			return new Response("{}", { status: 200 })
		}
		const options = { fetchImpl: flaky, probe: async () => true, retries: 0, sleep: async () => undefined }
		const res = await fetchWithNetworkRetry(SPEC, { method: "POST" }, { ...options, waitMs: 200 })
		expect(res.status).toBe(200)
	})

	it("passes AbortSignal when requestTimeoutMs is set", async () => {
		let sawSignal = false
		const seeing = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			sawSignal = init?.signal !== undefined
			return new Response("ok")
		}
		const options = { fetchImpl: seeing, requestTimeoutMs: 1_000, retries: 0, waitMs: 0 }
		expect((await fetchWithNetworkRetry(SPEC, {}, options)).status).toBe(200)
		expect(sawSignal).toBe(true)
	})

	it("uses the default origin probe after retries", async () => {
		await expect(
			fetchWithNetworkRetry(SPEC, {}, { ...ticking(), fetchImpl: failing("ECONNREFUSED"), retries: 0, waitMs: 80 }),
		).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "refused")
	})

	it("propagates a post-recovery failure", async () => {
		const options = { fetchImpl: failing("ECONNRESET"), probe: async () => true, retries: 0, waitMs: 100 }
		await expect(fetchWithNetworkRetry(SPEC, {}, { ...options, sleep: async () => undefined })).rejects.toSatisfy(
			(error: unknown) => isNetworkError(error) && error.kind === "reset",
		)
	})

	it("does not swallow a TLS / programming error", async () => {
		const options = { fetchImpl: failing("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), retries: 2, waitMs: 0 }
		await expect(fetchWithNetworkRetry(SPEC, {}, options)).rejects.toBeInstanceOf(TypeError)
	})
})
