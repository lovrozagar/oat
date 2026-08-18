import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"
import {
	NetworkError,
	classifyNetworkError,
	createNetworkGate,
	describeNetworkFailure,
	describeNetworkKind,
	fetchWithNetworkRetry,
	hasUsableInterface,
	isNetworkError,
	networkRetryWaitMs,
	probeOrigin,
	refineNetworkKind,
} from "../src/runtime/network.ts"
import { formatProgressLine, type ProgressSnapshot } from "../src/runtime/progress.ts"
import { renderMarkdown, type ReportInput } from "../src/report/render.ts"
import { run } from "../src/runtime/run.ts"

function net(code: string, message = "fetch failed"): TypeError {
	const cause = Object.assign(new Error(message), { code })
	return Object.assign(new TypeError("fetch failed"), { cause })
}

describe("classifyNetworkError", () => {
	it("maps nested Node / undici codes and fetch-failed text", () => {
		expect(classifyNetworkError(net("ENOTFOUND"))).toBe("dns")
		expect(classifyNetworkError(net("EAI_AGAIN"))).toBe("dns")
		expect(classifyNetworkError(net("ECONNREFUSED"))).toBe("refused")
		expect(classifyNetworkError(net("ECONNRESET"))).toBe("reset")
		expect(classifyNetworkError(net("EPIPE"))).toBe("reset")
		expect(classifyNetworkError(net("UND_ERR_SOCKET"))).toBe("reset")
		expect(classifyNetworkError(net("ETIMEDOUT"))).toBe("timeout")
		expect(classifyNetworkError(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe("timeout")
		expect(classifyNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout")
		expect(classifyNetworkError(net("ENETUNREACH"))).toBe("unreachable")
		expect(classifyNetworkError(net("ENETDOWN"))).toBe("unreachable")
		expect(classifyNetworkError(net("ENONET"))).toBe("offline")
		expect(classifyNetworkError(net("ERR_INTERNET_DISCONNECTED"))).toBe("offline")
		expect(classifyNetworkError(new TypeError("fetch failed"))).toBe("unknown")
		expect(classifyNetworkError(new TypeError("Failed to fetch"))).toBe("unknown")
		expect(classifyNetworkError("socket hang up")).toBe("unknown")
		expect(classifyNetworkError("getaddrinfo failed")).toBe("unknown")
		expect(classifyNetworkError(new TypeError("NetworkError when attempting to fetch"))).toBe("unknown")
		expect(classifyNetworkError(net("EAI_FAIL"))).toBe("dns")
		expect(classifyNetworkError(net("EAI_NODATA"))).toBe("dns")
		expect(classifyNetworkError(net("EAI_NONAME"))).toBe("dns")
		expect(classifyNetworkError(net("UND_ERR_DESTROYED"))).toBe("reset")
		expect(classifyNetworkError(net("UND_ERR_CONNECT_TIMEOUT"))).toBe("timeout")
		expect(classifyNetworkError(net("UND_ERR_HEADERS_TIMEOUT"))).toBe("timeout")
		expect(classifyNetworkError(net("UND_ERR_BODY_TIMEOUT"))).toBe("timeout")
		expect(classifyNetworkError(net("EHOSTUNREACH"))).toBe("unreachable")
		expect(classifyNetworkError(net("EHOSTDOWN"))).toBe("unreachable")
		expect(classifyNetworkError(net("ERR_NETWORK_CHANGED"))).toBe("offline")
		expect(classifyNetworkError(net("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBeNull()
		expect(classifyNetworkError(net("ERR_TLS_CERT_ALTNAME_INVALID"))).toBeNull()
		expect(classifyNetworkError(new SyntaxError("nope"))).toBeNull()
		expect(classifyNetworkError(null)).toBeNull()
		expect(classifyNetworkError({ code: "", name: "", message: "", cause: { code: "ENOTFOUND" } })).toBe("dns")
		const cycle: { cause?: unknown } = {}
		cycle.cause = cycle
		expect(classifyNetworkError(cycle)).toBeNull()
	})
})

describe("interfaces and kind copy", () => {
	it("treats a machine with no external address as offline", () => {
		expect(hasUsableInterface(() => ({}))).toBe(false)
		expect(hasUsableInterface(() => ({ lo: [{ address: "127.0.0.1", internal: true }] as never }))).toBe(false)
		expect(hasUsableInterface(() => ({ eth0: null }))).toBe(false)
		expect(hasUsableInterface(() => ({ eth0: [{ address: "", internal: false }] as never }))).toBe(false)
		expect(hasUsableInterface(() => ({ eth0: [{ address: "10.0.0.2", internal: false }] as never }))).toBe(true)
		expect(hasUsableInterface()).toBe(true)
		expect(refineNetworkKind("offline", () => ({ eth0: [{ address: "10.0.0.2", internal: false }] as never }))).toBe(
			"offline",
		)
		expect(refineNetworkKind("dns", () => ({}))).toBe("offline")
		expect(refineNetworkKind("dns", () => ({ eth0: [{ address: "10.0.0.2", internal: false }] as never }))).toBe("dns")
	})

	it("describes every kind and the retry schedule", () => {
		expect(describeNetworkKind("offline")).toMatch(/no usable network/)
		expect(describeNetworkKind("dns")).toMatch(/DNS/)
		expect(describeNetworkKind("refused")).toMatch(/refused/)
		expect(describeNetworkKind("reset")).toMatch(/reset/)
		expect(describeNetworkKind("timeout")).toMatch(/timed out/)
		expect(describeNetworkKind("unreachable")).toMatch(/no route/)
		expect(describeNetworkKind("unknown")).toMatch(/never reached/)
		expect(networkRetryWaitMs(0)).toBe(250)
		expect(networkRetryWaitMs(4)).toBe(4_000)
		const err = new NetworkError({
			attempts: 5,
			kind: "offline",
			message: "down",
			method: "GET",
			url: "http://x.test/",
		})
		expect(isNetworkError(err)).toBe(true)
		expect(isNetworkError(new Error("x"))).toBe(false)
		expect(err.code).toBe("NETWORK")
		expect(describeNetworkFailure(err)).toMatch(/5 attempt/)
		expect(describeNetworkFailure(err)).not.toMatch(/waiting/)
		expect(describeNetworkFailure(err, 60_000)).toMatch(/60s waiting/)
	})
})

describe("createNetworkGate", () => {
	it("recovers when the probe succeeds, then single-flights waiters", async () => {
		let probes = 0
		const sleeps: number[] = []
		let clock = 0
		const gate = createNetworkGate({
			now: () => clock,
			probe: async () => {
				probes += 1
				return probes >= 2
			},
			probeIntervalMs: 100,
			sleep: async (ms) => {
				sleeps.push(ms)
				clock += ms
			},
			waitBudgetMs: 1_000,
		})
		const err = new NetworkError({
			attempts: 1,
			kind: "reset",
			message: "reset",
			method: "GET",
			url: "http://x.test/",
		})
		const [a, b] = await Promise.all([gate.awaitRecovery(err), gate.awaitRecovery(err)])
		expect(a).toBe(true)
		expect(b).toBe(true)
		expect(probes).toBe(2)
		expect(sleeps.length).toBeGreaterThan(0)
		expect(gate.exhausted).toBe(false)
		expect(gate.lastKind).toBe("reset")
		expect(gate.waitedMs).toBeGreaterThan(0)
	})

	it("exhausts the budget and fails fast afterwards", async () => {
		const waits: Array<{ kind: string; remainingMs: number }> = []
		let clock = 0
		const gate = createNetworkGate({
			now: () => clock,
			onWait: (info) => waits.push({ kind: info.kind, remainingMs: info.remainingMs }),
			probe: async () => false,
			probeIntervalMs: 50,
			sleep: async (ms) => {
				clock += ms
			},
			waitBudgetMs: 120,
		})
		const err = new NetworkError({
			attempts: 1,
			kind: "offline",
			message: "off",
			method: "GET",
			url: "http://x.test/",
		})
		expect(await gate.awaitRecovery(err)).toBe(false)
		expect(gate.exhausted).toBe(true)
		expect(await gate.awaitRecovery(err)).toBe(false)
		expect(waits[0]?.kind).toBe("offline")
		expect(waits.some((row) => row.remainingMs === 120)).toBe(true)
	})

	it("uses default wait budget and probe interval", async () => {
		let clock = 0
		const gate = createNetworkGate({
			now: () => clock,
			probe: async () => true,
			sleep: async (ms) => {
				clock += ms
			},
		})
		const err = new NetworkError({
			attempts: 1,
			kind: "reset",
			message: "reset",
			method: "GET",
			url: "http://x.test/",
		})
		expect(await gate.awaitRecovery(err)).toBe(true)
		expect(clock).toBe(2_000)
	})

	it("skips the wait when the budget is 0", async () => {
		const gate = createNetworkGate({
			probe: async () => true,
			waitBudgetMs: 0,
		})
		const err = new NetworkError({
			attempts: 1,
			kind: "dns",
			message: "dns",
			method: "GET",
			url: "http://x.test/",
		})
		expect(await gate.awaitRecovery(err)).toBe(false)
		expect(gate.exhausted).toBe(true)
		expect(gate.lastKind).toBe("dns")
	})
})

describe("probeOrigin / fetchWithNetworkRetry", () => {
	it("probeOrigin treats a reachable host as up and a refused port as down", async () => {
		expect(await probeOrigin("http://x.test", { online: () => false })).toBe(false)
		expect(await probeOrigin("not a url")).toBe(false)
		expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 404 }) })).toBe(
			true,
		)
		expect(
			await probeOrigin("http://x.test", {
				fetchImpl: async () => {
					throw net("ECONNREFUSED")
				},
			}),
		).toBe(false)
		expect(
			await probeOrigin("http://x.test", {
				fetchImpl: async () => {
					throw new SyntaxError("bug")
				},
			}),
		).toBe(true)
		expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 204 }) })).toBe(
			true,
		)
	})

	it("uses default retries, fetch, sleep, and wait budget", async () => {
		const original = globalThis.fetch
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch
		try {
			const res = await fetchWithNetworkRetry("http://x.test/spec")
			expect(await res.text()).toBe("ok")
		} finally {
			globalThis.fetch = original
		}

		let clock = 0
		const waits: string[] = []
		await expect(
			fetchWithNetworkRetry(
				"http://x.test/spec",
				{},
				{
					fetchImpl: async () => {
						throw net("ECONNRESET")
					},
					now: () => clock,
					onWait: (info) => waits.push(info.kind),
					retries: 0,
					sleep: async (ms) => {
						clock += ms
					},
				},
			),
		).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "reset")
		expect(waits.length).toBeGreaterThan(0)
	})

	it("retries a blip and then succeeds", async () => {
		let hits = 0
		const sleeps: number[] = []
		const res = await fetchWithNetworkRetry(
			"http://x.test/spec",
			{ method: "GET" },
			{
				fetchImpl: async () => {
					hits += 1
					if (hits < 3) throw net("ECONNRESET")
					return new Response("ok", { status: 200 })
				},
				retries: 4,
				sleep: async (ms) => {
					sleeps.push(ms)
				},
				waitMs: 0,
			},
		)
		expect(await res.text()).toBe("ok")
		expect(hits).toBe(3)
		expect(sleeps).toEqual([250, 500])
	})

	it("waits for the link after retries, then fails with a named NetworkError", async () => {
		let clock = 0
		await expect(
			fetchWithNetworkRetry(
				"http://x.test/spec",
				{},
				{
					fetchImpl: async () => {
						throw net("ENETUNREACH")
					},
					now: undefined,
					probe: async () => false,
					retries: 0,
					sleep: async (ms) => {
						clock += ms
					},
					waitMs: 80,
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			return (
				isNetworkError(error) &&
				error.kind === "unreachable" &&
				error.message.includes("never") === false &&
				error.message.includes("not a backend")
			)
		})
		void clock
	})

	it("recovers after the wait budget probe succeeds", async () => {
		let hits = 0
		const res = await fetchWithNetworkRetry(
			"http://x.test/spec",
			{ method: "POST" },
			{
				fetchImpl: async () => {
					hits += 1
					if (hits === 1) throw net("ENOTFOUND")
					return new Response("{}", { status: 200 })
				},
				probe: async () => true,
				retries: 0,
				sleep: async () => undefined,
				waitMs: 200,
			},
		)
		expect(res.status).toBe(200)
	})

	it("passes AbortSignal when requestTimeoutMs is set", async () => {
		let sawSignal = false
		const res = await fetchWithNetworkRetry(
			"http://x.test/spec",
			{},
			{
				fetchImpl: async (_url, init) => {
					sawSignal = init?.signal !== undefined
					return new Response("ok")
				},
				requestTimeoutMs: 1_000,
				retries: 0,
				waitMs: 0,
			},
		)
		expect(res.status).toBe(200)
		expect(sawSignal).toBe(true)
	})

	it("uses the default origin probe after retries", async () => {
		let clock = 0
		await expect(
			fetchWithNetworkRetry(
				"http://x.test/spec",
				{},
				{
					fetchImpl: async () => {
						throw net("ECONNREFUSED")
					},
					now: () => clock,
					retries: 0,
					sleep: async (ms) => {
						clock += ms
					},
					waitMs: 80,
				},
			),
		).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "refused")
	})

	it("propagates a post-recovery failure", async () => {
		await expect(
			fetchWithNetworkRetry(
				"http://x.test/spec",
				{},
				{
					fetchImpl: async () => {
						throw net("ECONNRESET")
					},
					probe: async () => true,
					retries: 0,
					sleep: async () => undefined,
					waitMs: 100,
				},
			),
		).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "reset")
	})

	it("does not swallow a TLS / programming error", async () => {
		await expect(
			fetchWithNetworkRetry(
				"http://x.test/spec",
				{},
				{
					fetchImpl: async () => {
						throw net("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
					},
					retries: 2,
					waitMs: 0,
				},
			),
		).rejects.toBeInstanceOf(TypeError)
	})
})

describe("Client records a status-0 network exchange and retries", () => {
	it("journals the failed attempt and succeeds on retry", async () => {
		const seen: number[] = []
		let hits = 0
		const original = globalThis.fetch
		globalThis.fetch = (async () => {
			hits += 1
			if (hits === 1) throw net("ECONNRESET")
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
		}) as typeof fetch
		try {
			const client = new Client(
				"http://x.test",
				{},
				1,
				(exchange) => {
					seen.push(exchange.status)
				},
				undefined,
				undefined,
				{ retries: 2, waitMs: undefined },
			)
			const exchange = await client.get("/v1/x")
			expect(exchange.status).toBe(200)
			expect(seen).toEqual([0, 200])
			expect(client.transcript[0]?.network?.kind).toBe("reset")
			expect(client.transcript[0]?.status).toBe(0)
			expect(client.transcript[0]?.responseBody).toMatchObject({ error: "network", kind: "reset" })
		} finally {
			globalThis.fetch = original
		}
	})

	it("throws NetworkError after retries when recovery says no", async () => {
		const original = globalThis.fetch
		globalThis.fetch = (async () => {
			throw net("ENONET")
		}) as typeof fetch
		try {
			const client = new Client("http://x.test", {}, 1, undefined, undefined, undefined, {
				awaitRecovery: async () => false,
				retries: 0,
			})
			await expect(client.get("/v1/x")).rejects.toSatisfy(
				(error: unknown) => isNetworkError(error) && error.kind === "offline",
			)
		} finally {
			globalThis.fetch = original
		}
	})

	it("retries once more when recovery succeeds", async () => {
		const original = globalThis.fetch
		let hits = 0
		globalThis.fetch = (async () => {
			hits += 1
			if (hits === 1) throw net("ECONNREFUSED")
			return new Response("{}", { status: 200 })
		}) as typeof fetch
		try {
			const client = new Client("http://x.test", {}, 1, undefined, undefined, undefined, {
				awaitRecovery: async () => true,
				retries: 0,
			})
			expect((await client.get("/v1/x")).status).toBe(200)
		} finally {
			globalThis.fetch = original
		}
	})
})

describe("progress and report name the network", () => {
	it("marks status=network on a failed last call", () => {
		const snap: ProgressSnapshot = {
			elapsedMs: 10,
			findings: 0,
			last: {
				at: Date.now(),
				durationMs: 3,
				method: "GET",
				network: "offline",
				requestBytes: 10,
				requestId: "",
				responseBytes: 0,
				status: 0,
				url: "http://x.test/v1",
			},
			phase: "test",
			requests: 1,
		}
		expect(formatProgressLine(snap)).toMatch(/status=network/)
	})

	it("prints a network line on the markdown report", () => {
		const md = renderMarkdown({
			baseUrl: "http://x.test",
			checksRun: [],
			client: { transcript: [] },
			durationMs: 1,
			entitiesTested: [],
			findings: [],
			model: { entities: new Map(), operations: [] },
			network: { attempts: 5, incomplete: true, kind: "offline", url: "http://x.test/v1", waitedMs: 60_000 },
			startedAt: new Date("2026-08-18T00:00:00.000Z"),
		} as unknown as ReportInput)
		expect(md).toMatch(/\*\*Network\*\*: offline after 5 attempt\(s\) · waited 60s — run incomplete/)
	})
})

describe("run() names a dead API as net.unreachable", () => {
	it("does not crash and records the kind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-net-"))
		const spec = join(dir, "openapi.json")
		await writeFile(
			spec,
			JSON.stringify({
				info: { title: "n", version: "1" },
				openapi: "3.1.0",
				paths: {
					"/v1/widgets": {
						get: {
							operationId: "widget.list",
							responses: { "200": { description: "ok" } },
							"x-entity": { action: "list", identity: "id", name: "widget" },
						},
						post: {
							operationId: "widget.create",
							requestBody: {
								content: {
									"application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } },
								},
							},
							responses: { "201": { description: "ok" } },
							"x-entity": { action: "create", identity: "id", name: "widget" },
						},
					},
				},
			}),
		)
		const result = await run({
			baseUrl: "http://127.0.0.1:1",
			network: { retries: 0, waitMs: 0 },
			principals: [{ headers: { authorization: "Bearer t" }, id: "a" }],
			seed: 1,
			spec,
		})
		expect(result.network?.incomplete).toBe(true)
		expect(result.network?.kind).toMatch(/refused|unreachable|offline|unknown/)
		expect(result.findings.some((finding) => finding.check === "net.unreachable")).toBe(true)
		expect(result.findings.some((finding) => finding.detail.includes("not a backend"))).toBe(true)
		expect(result.client.transcript.some((exchange) => exchange.status === 0 && exchange.network !== undefined)).toBe(
			true,
		)
	})
})
