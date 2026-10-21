import { describe, expect, it } from "vitest"
import { memoryStore } from "../engines.ts"
import { referenceState } from "../reference.ts"
import type { ReferenceOptions } from "../state.ts"
import { noteLogin, throttled } from "./throttle.ts"

const T0 = 1_800_000_000_000

async function world(options: ReferenceOptions = {}) {
	const now = { ms: T0 }
	const state = await referenceState({ clock: () => now.ms, ...options }, memoryStore)
	return { now, state }
}

/* Fails `count` logins for `identity`, a second apart, and answers whether the next is throttled. */
function failLogins(state: Awaited<ReturnType<typeof world>>, identity: string, count: number): void {
	for (let index = 0; index < count; index += 1) {
		noteLogin(state.state, identity, false)
		state.now.ms += 1000
	}
}

describe("throttled", () => {
	it("answers 429 with Retry-After once one identity has failed 5 logins within a minute", async () => {
		const state = await world({ throttleLogins: true })
		failLogins(state, "key:nobody", 4)
		expect(throttled(state.state, "key:nobody")).toBeUndefined()
		failLogins(state, "key:nobody", 1)
		const answer = throttled(state.state, "key:nobody")
		expect(answer?.status).toBe(429)
		/* The first failure was at T0; it leaves the window at T0 + 60s, and the clock reads T0 + 5s. */
		expect(answer?.headers["retry-after"]).toBe("55")
		expect(JSON.parse(answer?.body ?? "")).toEqual({
			error_key: "too_many_requests",
			message: "too many failed logins; retry later",
			status: 429,
			success: false,
		})
		expect(throttled(state.state, "key:somebody")).toBeUndefined()
	})

	it("forgets failures older than a minute, retries after at least a second, and clears on a success", async () => {
		const state = await world({ throttleLogins: true })
		failLogins(state, "email:a", 5)
		state.now.ms = T0 + 59_999
		expect(throttled(state.state, "email:a")?.headers["retry-after"]).toBe("1")
		state.now.ms = T0 + 60_000
		expect(throttled(state.state, "email:a")).toBeUndefined()
		failLogins(state, "email:b", 5)
		noteLogin(state.state, "email:b", true)
		expect(throttled(state.state, "email:b")).toBeUndefined()
	})

	it("never throttles without throttleLogins, or under LOGIN_NOT_THROTTLED", async () => {
		for (const options of [{}, { defects: ["LOGIN_NOT_THROTTLED"], throttleLogins: true }]) {
			const state = await world(options)
			failLogins(state, "key:nobody", 10)
			expect(throttled(state.state, "key:nobody")).toBeUndefined()
		}
	})
})
