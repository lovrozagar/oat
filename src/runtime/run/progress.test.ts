import { describe, expect, it } from "vitest"
import type { Exchange, RequestStart } from "../client.ts"
import type { ProgressSnapshot } from "../progress.ts"
import { RunProgress } from "./progress.ts"

/*
 * The live status: where the run is, the last answer, and the oldest request still out. Every
 * move publishes a snapshot; a field the run is not on is absent, never stale.
 */

function staged(defects = 0) {
	const snaps: ProgressSnapshot[] = []
	const progress = new RunProgress(
		(snap) => snaps.push(snap),
		Date.now(),
		() => defects,
	)
	return { progress, snaps }
}

const probe = (at: number, requestId = ""): RequestStart => ({
	at,
	method: "GET",
	requestBytes: 12,
	requestId,
	url: `http://api.test/${at}`,
})

const answer = {
	at: 5,
	durationMs: 3,
	method: "GET",
	requestBytes: 1,
	requestId: "r1",
	responseBytes: 2,
	status: 200,
	url: "u",
}

describe("RunProgress ticks", () => {
	it("moves the run and publishes where it is, keeping what a tick leaves out", () => {
		const { progress, snaps } = staged(2)
		progress.tick({
			check: "c1",
			entity: "note",
			entityIndex: 1,
			entityTotal: 3,
			message: "m",
			phase: "test",
			requests: 7,
		})
		progress.tick({ phase: "teardown" })
		expect(snaps[0]).toMatchObject({
			check: "c1",
			entity: "note",
			entityIndex: 1,
			entityTotal: 3,
			findings: 2,
			message: "m",
			phase: "test",
			requests: 7,
		})
		expect(snaps[1]).toMatchObject({ check: "c1", entity: "note", phase: "teardown", requests: 0 })
		expect(snaps[1]).not.toHaveProperty("message")
		expect(snaps[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
	})

	it("counts requests from what it was given, once given", () => {
		const { progress, snaps } = staged()
		expect(progress.requests).toBe(0)
		progress.countRequests(() => 9)
		progress.tick({ phase: "load" })
		expect(snaps[0]?.requests).toBe(9)
	})

	it("enters a stage with no check, naming it", () => {
		const { progress, snaps } = staged()
		progress.check = "c1"
		progress.enter("contract", "operations no check reached")
		expect(snaps[0]).toMatchObject({ message: "operations no check reached", phase: "contract" })
		expect(snaps[0]).not.toHaveProperty("check")
	})

	it("publishes nothing without a handler", () => {
		const progress = new RunProgress(undefined, 0, () => 0)
		expect(() => progress.tick({ phase: "load" })).not.toThrow()
	})
})

describe("RunProgress requests", () => {
	it("shows each request as it starts, and the oldest one still out", () => {
		const { progress, snaps } = staged()
		const late = probe(20, "req-2")
		progress.httpHooks.start?.(probe(10))
		progress.httpHooks.start?.(late)
		expect(snaps[0]?.inflight).toEqual({ at: 10, method: "GET", requestBytes: 12, url: "http://api.test/10" })
		expect(snaps[1]?.inflight).toEqual({
			at: 20,
			method: "GET",
			requestBytes: 12,
			requestId: "req-2",
			url: "http://api.test/20",
		})
		progress.tick({ phase: "test" })
		expect(snaps[2]?.inflight?.at).toBe(10)
	})

	it("shows the last answer, then the oldest request still out", () => {
		const { progress, snaps } = staged()
		const first = probe(10)
		progress.httpHooks.start?.(first)
		progress.httpHooks.start?.(probe(20))
		progress.httpHooks.end?.(first)
		progress.remember({ ...answer, network: { kind: "timeout" } } as unknown as Exchange)
		progress.announce()
		const [, , shown, waiting] = snaps
		expect(shown?.last).toEqual({ ...answer, network: "timeout" })
		expect(shown).not.toHaveProperty("inflight")
		expect(waiting?.inflight?.at).toBe(20)
	})

	it("announces once when nothing is still out", () => {
		const { progress, snaps } = staged()
		progress.remember(answer as unknown as Exchange)
		progress.announce()
		expect(snaps).toHaveLength(1)
		expect(snaps[0]?.last).toEqual(answer)
	})
})
