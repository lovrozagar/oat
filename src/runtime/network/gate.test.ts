import { afterEach, describe, expect, it, vi } from "vitest"
import { NetworkError } from "../../errors/network.ts"
import { createNetworkGate, type NetworkGateOptions, type NetworkWaitInfo } from "./gate.ts"

const failure = new NetworkError({
	attempts: 5,
	kind: "reset",
	message: "reset",
	method: "GET",
	url: "http://h.test/x",
})

/** A clock that only moves when the gate sleeps. */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
	let at = 1_000
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
	vi.useRealTimers()
})

describe("createNetworkGate without a budget", () => {
	it("gives up at once and stays given up", async () => {
		const probe = vi.fn<NetworkGateOptions["probe"]>(async () => true)
		const gate = createNetworkGate({ probe, waitBudgetMs: 0 })
		expect(await gate.awaitRecovery(failure)).toBe(false)
		expect([gate.exhausted, gate.lastKind, gate.waitedMs]).toEqual([true, "reset", 0])
		expect(await gate.awaitRecovery(failure)).toBe(false)
		expect(probe).not.toHaveBeenCalled()
	})
})

describe("createNetworkGate with a budget", () => {
	it("probes on its interval until the link answers, and reports each wait", async () => {
		const clock = virtualClock()
		const waits: NetworkWaitInfo[] = []
		const answers = [false, true]
		const gate = createNetworkGate({
			now: clock.now,
			onWait: (wait) => waits.push(wait),
			probe: async () => answers.shift() as boolean,
			probeIntervalMs: 1_000,
			sleep: clock.sleep,
			waitBudgetMs: 5_000,
		})
		expect(gate.lastKind).toBeUndefined()
		expect(await gate.awaitRecovery(failure)).toBe(true)
		expect(clock.slept).toEqual([1_000, 1_000])
		expect(waits).toEqual([
			{ elapsedMs: 0, kind: "reset", remainingMs: 5_000 },
			{ elapsedMs: 1_000, kind: "reset", remainingMs: 4_000 },
			{ elapsedMs: 2_000, kind: "reset", remainingMs: 3_000 },
		])
		expect([gate.exhausted, gate.waitedMs]).toEqual([false, 2_000])
	})

	it("exhausts the budget when the link never answers, never probing faster than 50ms", async () => {
		const clock = virtualClock()
		const gate = createNetworkGate({
			now: clock.now,
			probe: async () => false,
			probeIntervalMs: 1,
			sleep: clock.sleep,
			waitBudgetMs: 120,
		})
		expect(await gate.awaitRecovery(failure)).toBe(false)
		expect(clock.slept).toEqual([50, 50, 20])
		expect([gate.exhausted, gate.waitedMs]).toEqual([true, 120])
	})

	it("shares one wait between concurrent callers, and waits again once it settles", async () => {
		const clock = virtualClock()
		const probe = vi.fn<NetworkGateOptions["probe"]>(async () => true)
		const gate = createNetworkGate({ now: clock.now, probe, sleep: clock.sleep, waitBudgetMs: 10_000 })
		const first = gate.awaitRecovery(failure)
		expect(gate.awaitRecovery(failure)).toBe(first)
		expect(await first).toBe(true)
		expect(await gate.awaitRecovery(failure)).toBe(true)
		expect(probe).toHaveBeenCalledTimes(2)
	})

	it("waits on the real clock by default: a minute's budget, a probe every two seconds", async () => {
		vi.useFakeTimers()
		const probe = vi.fn<NetworkGateOptions["probe"]>(async () => true)
		const gate = createNetworkGate({ probe })
		const recovered = gate.awaitRecovery(failure)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(await recovered).toBe(true)
		expect(gate.waitedMs).toBe(2_000)
	})
})
