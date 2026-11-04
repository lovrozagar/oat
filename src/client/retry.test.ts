import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { DEFAULT_NETWORK_RETRIES } from "../runtime/network/policy.ts"
import { NetworkError, type NetworkKind } from "../errors/network.ts"
import { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { MAX_429_RETRIES, MAX_UNAVAILABLE_RETRIES } from "../runtime/rate-limit/retry-after.ts"
import { type Resending, resilient, type StatusRetry, untilAnswered } from "./retry.ts"

const answer = (status: number, headers: Record<string, string> = {}): Exchange =>
	({ responseHeaders: headers, status }) as Exchange
const failure = (kind: NetworkKind): NetworkError =>
	new NetworkError({ attempts: 1, kind, message: kind, method: "GET", url: "http://api.test/" })

const policy = (more: Partial<Resending> = {}): Resending => ({
	deadline: performance.now() + 3_600_000,
	headers: () => ({}),
	method: "GET",
	network: {},
	...more,
})

/** Runs `work` while letting every timer it starts fire at once. */
async function settled<T>(work: Promise<T>): Promise<T> {
	const outcome = work.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	)
	await vi.runAllTimersAsync()
	const result = await outcome
	if ("error" in result) throw result.error
	return result.value
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout"] })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("resilient", () => {
	it("returns the first answer", async () => {
		const sent: number[] = []
		const ok = answer(200)
		expect(await resilient(async (attempt) => (sent.push(attempt), ok), policy())).toBe(ok)
		expect(sent).toEqual([0])
	})

	it("raises at once what is not a network failure, or a write that may have landed", async () => {
		await expect(resilient(() => Promise.reject(new Error("bug")), policy())).rejects.toThrow("bug")
		const write = policy({ method: "POST" })
		const reset = failure("reset")
		await expect(resilient(() => Promise.reject(reset), write)).rejects.toBe(reset)
	})

	it("resends what never left, an idempotent method, or a write with an idempotency key", async () => {
		for (const [kind, more] of [
			["refused", { method: "POST" }],
			["reset", { method: "PUT" }],
			["reset", { method: "QUERY" }],
			["timeout", { headers: () => ({ "Idempotency-Key": "k" }), method: "POST" }],
		] as const) {
			const sent: number[] = []
			const exchange = await settled(
				resilient(async (attempt) => {
					sent.push(attempt)
					if (attempt < 2) throw failure(kind)
					return answer(200)
				}, policy(more)),
			)
			expect([kind, exchange.status, sent]).toEqual([kind, 200, [0, 1, 2]])
		}
	})

	it("tries the default number of times when no count is set, and once with no network policy", async () => {
		const sent: number[] = []
		const down = (attempt: number): Promise<Exchange> => (sent.push(attempt), Promise.reject(failure("refused")))
		await expect(settled(resilient(down, policy()))).rejects.toBeInstanceOf(NetworkError)
		expect(sent).toHaveLength(DEFAULT_NETWORK_RETRIES + 1)
		sent.length = 0
		await expect(settled(resilient(down, policy({ network: undefined })))).rejects.toBeInstanceOf(NetworkError)
		await expect(settled(resilient(down, policy({ network: { retries: -3 } })))).rejects.toBeInstanceOf(NetworkError)
		expect(sent).toEqual([0, 0])
	})
})

describe("resilient within its deadline", () => {
	it("stops when the next wait would pass the deadline", async () => {
		const sent: number[] = []
		const down = (attempt: number): Promise<Exchange> => (sent.push(attempt), Promise.reject(failure("refused")))
		await expect(resilient(down, policy({ deadline: performance.now() + 10 }))).rejects.toBeInstanceOf(NetworkError)
		expect(sent).toEqual([0])
	})

	it("sends once more when the link recovers, and raises the last failure when it does not", async () => {
		const last = failure("unreachable")
		const recovering = policy({ network: { awaitRecovery: async (error) => error === last, retries: 1 } })
		const sent: number[] = []
		const exchange = await settled(
			resilient(async (attempt) => {
				sent.push(attempt)
				if (attempt < 2) throw last
				return answer(200)
			}, recovering),
		)
		expect([exchange.status, sent]).toEqual([200, [0, 1, 2]])
		const lost = policy({ network: { awaitRecovery: async () => false, retries: 0 } })
		await expect(resilient(() => Promise.reject(last), lost)).rejects.toBe(last)
	})
})

function retrying(answers: Exchange[], method = "GET"): StatusRetry & { log: string[] } {
	const log: string[] = []
	let next = 0
	return {
		again: async (previous) => {
			log.push(`again after ${previous.status}`)
			return answers[next++] as Exchange
		},
		backedOff: (waitMs) => log.push(`backoff ${waitMs}`),
		log,
		method,
		reauthorized: async (exchange) => {
			log.push(`reauthorized ${exchange.status}`)
			return exchange
		},
	}
}

describe("untilAnswered", () => {
	it("waits out a 429 as told, through reauthorization, until it passes", async () => {
		const retry = retrying([answer(429, { "retry-after": "0" }), answer(200)])
		const final = await settled(untilAnswered(answer(429, { "retry-after": "2" }), retry))
		expect(final.status).toBe(200)
		expect(retry.log).toEqual([
			"backoff 2000",
			"again after 429",
			"reauthorized 429",
			"backoff 0",
			"again after 429",
			"reauthorized 200",
		])
	})

	it("lets a 429 stand after the last retry", async () => {
		const retry = retrying(Array.from({ length: MAX_429_RETRIES }, () => answer(429)))
		expect((await settled(untilAnswered(answer(429), retry))).status).toBe(429)
		expect(retry.log.filter((line) => line.startsWith("again"))).toHaveLength(MAX_429_RETRIES)
	})

	it("waits out a 503 that names its wait, and lets one stand that names none", async () => {
		const retry = retrying([answer(503, { "retry-after": "1" }), answer(200)])
		expect((await settled(untilAnswered(answer(503, { "retry-after": "1" }), retry))).status).toBe(200)
		const silent = retrying([], "POST")
		expect((await settled(untilAnswered(answer(503), silent))).status).toBe(503)
		expect(silent.log).toEqual([])
		/* A header-less 503 on a read is still asked once more, as a gateway's. */
		const read = retrying([answer(503)])
		expect((await settled(untilAnswered(answer(503), read))).status).toBe(503)
		expect(read.log).toEqual(["again after 503"])
	})

	it("stops waiting on 503 after its retries", async () => {
		const unavailable = (): Exchange => answer(503, { "retry-after": "1" })
		const retry = retrying([unavailable(), unavailable(), unavailable(), answer(502)], "POST")
		expect((await settled(untilAnswered(unavailable(), retry))).status).toBe(503)
		expect(retry.log).toEqual(["again after 503", "again after 503", "again after 503"])
	})

	it("asks a read once more past a gateway's 5xx, and never a write", async () => {
		const read = retrying([answer(504)])
		expect((await settled(untilAnswered(answer(502), read))).status).toBe(504)
		expect(read.log).toEqual(["again after 502"])
		const write = retrying([])
		expect((await settled(untilAnswered(answer(502), { ...write, method: "POST" }))).status).toBe(502)
		const fine = retrying([])
		expect((await untilAnswered(answer(200), fine)).status).toBe(200)
		/* A QUERY carries its question in a body, which may be a stream already spent. */
		const query = retrying([])
		expect((await settled(untilAnswered(answer(502), { ...query, method: "QUERY" }))).status).toBe(502)
		expect([...write.log, ...fine.log, ...query.log]).toEqual([])
	})
})

/* A backend that sheds load with a 503 and then rate-limits the retry with a 429 (anyrow's D1 under a
 * teardown burst): each answer names its wait, and oat follows whichever one came last. */
const shed = (): Exchange => answer(503, { "retry-after": "1" })
const throttled = (): Exchange => answer(429, { "retry-after": "1" })
describe("untilAnswered when a 503 and a 429 follow each other", () => {
	it("waits out a 429 that answers a 503's retry", async () => {
		const retry = retrying([answer(429, { "retry-after": "1" }), answer(200)], "DELETE")
		const final = await settled(untilAnswered(answer(503, { "retry-after": "1" }), retry))
		expect(final.status).toBe(200)
		expect(retry.log).toEqual(["again after 503", "backoff 1000", "again after 429", "reauthorized 200"])
	})

	it("waits out a 503 that answers a 429's retry", async () => {
		const retry = retrying([answer(503, { "retry-after": "1" }), answer(200)], "DELETE")
		const final = await settled(untilAnswered(answer(429, { "retry-after": "1" }), retry))
		expect(final.status).toBe(200)
		expect(retry.log).toEqual(["backoff 1000", "again after 429", "reauthorized 503", "again after 503"])
	})

	it("stops at each status's own retries when the two alternate without end", async () => {
		const answers = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? throttled() : shed()))
		const retry = retrying(answers, "DELETE")
		const final = await settled(untilAnswered(shed(), retry))
		const after = (status: number) => retry.log.filter((line) => line === `again after ${status}`).length
		/* a 503 opens and the two alternate, so the 503's cap ends it with as many 429s waited out */
		expect(after(503)).toBe(MAX_UNAVAILABLE_RETRIES)
		expect(after(429)).toBe(MAX_UNAVAILABLE_RETRIES)
		expect(final).toBe(answers[after(503) + after(429) - 1])
	})
})

describe("untilAnswered while a 429 holds the route", () => {
	it("resends a 503 at the later of its own wait and the cooldown, never their sum", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "performance"] })
		const limiter = new RateLimiter([], { random: () => 0 })
		const retry = retrying([], "DELETE")
		let resentAt: number | undefined
		retry.again = async () => {
			await limiter.waitImplicit("DELETE")
			resentAt = performance.now()
			return answer(200)
		}
		/* Another write's 429 holds every untagged write for 60 s, 5 s into the 503's 14 s wait. */
		setTimeout(() => limiter.noteBackoff({ method: "DELETE", pathname: "/webhooks/1" }, 60_000), 5_000)
		await settled(untilAnswered(answer(503, { "retry-after": "14" }), retry))
		expect(resentAt).toBe(65_000)
	})
})

describe("untilAnswered against the Retry-After limit", () => {
	it("waits out every 503 within the limit, however long the waits add up to", async () => {
		const longish = (): Exchange => answer(503, { "retry-after": "45" })
		const retry = retrying([longish(), longish(), answer(200)], "POST")
		const final = await settled(untilAnswered(longish(), retry))
		expect(final.status).toBe(200)
		expect(retry.log).toEqual(["again after 503", "again after 503", "again after 503"])
	})

	it("lets a 429 or a 503 stand at once when its wait is past the limit", async () => {
		const exceeded = { limitMs: 60_000, waitMs: 86_400_000 }
		for (const status of [429, 503]) {
			const marked = { ...answer(status, { "retry-after": "86400" }), retryAfterExceeded: exceeded } as Exchange
			const retry = retrying([answer(200)])
			const final = await settled(untilAnswered(marked, retry))
			expect([status, final.status, final.retryAfterExceeded, retry.log]).toEqual([status, status, exceeded, []])
		}
	})

	it("waits out a 429 within the limit in full", async () => {
		const retry = retrying([answer(200)])
		expect((await settled(untilAnswered(answer(429, { "retry-after": "45" }), retry))).status).toBe(200)
		expect(retry.log).toEqual(["backoff 45000", "again after 429", "reauthorized 200"])
	})
})
