import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROGRESS_GLOSSARY } from "./columns.ts"
import { STALL_MS } from "./fields.ts"
import { createProgressPrinter, createProgressPump, HEARTBEAT_MS, progressEventKey } from "./pump.ts"
import type { ProgressSnapshot } from "./types.ts"

const START = Date.parse("2030-01-01T00:00:00Z")
const snap = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
	elapsedMs: 0,
	findings: 0,
	phase: "test",
	requests: 0,
	...over,
})
const LAST = {
	at: START,
	durationMs: 1,
	method: "GET",
	requestBytes: 1,
	requestId: "",
	responseBytes: 1,
	status: 200,
	url: "http://h.test/",
}

beforeEach(() => {
	vi.useFakeTimers({ now: START })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("progressEventKey", () => {
	it("changes with the phase, entity, check, message, call on the wire, and last call", () => {
		expect(progressEventKey(snap())).toBe("test|||||")
		const full = snap({
			check: "c",
			entity: "e",
			inflight: { at: 5, method: "GET", url: "u" },
			last: { ...LAST, at: 7 },
			message: "m",
		})
		expect(progressEventKey(full)).toBe("test|e|c|m|GET u 5|7")
	})
})

describe("createProgressPump, on emit", () => {
	it("writes a new event, and the run's start, end, calls and seeding always", () => {
		const writes: string[] = []
		const pump = createProgressPump(START, (s) => writes.push(s.phase))
		pump.emit(snap())
		pump.emit(snap())
		for (const phase of ["load", "auth", "done"] as const) pump.emit(snap({ phase }))
		pump.emit(snap({ phase: "done" }))
		pump.emit(snap({ phase: "seed" }))
		pump.emit(snap({ phase: "seed" }))
		pump.emit(snap({ check: "c", phase: "seed" }))
		pump.emit(snap({ check: "c", phase: "seed" }))
		pump.emit(snap({ check: "c", inflight: { at: START, method: "GET", url: "u" }, phase: "seed" }))
		pump.emit(snap({ check: "c", inflight: { at: START, method: "GET", url: "u" }, phase: "seed" }))
		expect(writes).toEqual(["test", "load", "auth", "done", "done", "seed", "seed", "seed", "seed", "seed"])
		pump.stop()
	})

	it("writes a repeat once two seconds passed, or once the last call has gone quiet", () => {
		const writes: number[] = []
		const pump = createProgressPump(START, (_s, now) => writes.push(now - START))
		pump.emit(snap({ last: LAST }))
		vi.setSystemTime(START + 1_999)
		pump.emit(snap({ last: LAST }))
		vi.setSystemTime(START + 2_000)
		pump.emit(snap({ last: LAST }))
		const quiet = snap({ last: { ...LAST, at: Date.now() - STALL_MS } })
		pump.emit(quiet)
		pump.emit(quiet)
		expect(writes).toEqual([0, 2_000, 2_000, 2_000])
		pump.stop()
	})
})

describe("createProgressPump, heartbeat", () => {
	it("re-writes the latest event every five seconds with the time since the start, until stopped", async () => {
		const writes: Array<[number, number]> = []
		const pump = createProgressPump(START - 100, (s, now) => writes.push([s.elapsedMs, now - START]))
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
		expect(writes).toEqual([])
		pump.emit(snap())
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
		pump.stop()
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
		expect(writes).toEqual([
			[0, HEARTBEAT_MS],
			[HEARTBEAT_MS * 2 + 100, HEARTBEAT_MS * 2],
		])
	})
})

describe("createProgressPrinter", () => {
	it("prints the glossary once, then one logfmt line per event", () => {
		const out: string[] = []
		const printer = createProgressPrinter((text) => out.push(text))
		printer.emit(snap({ phase: "load" }))
		printer.emit(snap({ phase: "done" }))
		printer.stop()
		expect(out[0]).toBe(`${PROGRESS_GLOSSARY}\n`)
		expect(out.slice(1).map((line) => line.includes("phase=") && line.endsWith("\n"))).toEqual([true, true])
		expect(out).toHaveLength(3)
	})
})
