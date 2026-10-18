import { describe, expect, it } from "vitest"
import { formatProgressJsonl, formatProgressLine, formatProgressTsv } from "./format.ts"
import type { ProgressSnapshot } from "./types.ts"

const AT = Date.parse("2030-01-01T00:00:00Z")
const settled: ProgressSnapshot = {
	check: "list.pages",
	elapsedMs: 50,
	entity: "items",
	entityIndex: 1,
	entityTotal: 2,
	findings: 0,
	last: {
		at: AT,
		durationMs: 4,
		method: "GET",
		requestBytes: 10,
		requestId: "",
		responseBytes: 20,
		status: 200,
		url: "http://h.test/a",
	},
	message: "page two",
	phase: "test",
	requests: 3,
}
const waiting: ProgressSnapshot = {
	elapsedMs: 0,
	findings: 0,
	inflight: { at: AT, method: "POST", url: "http://h.test/b" },
	phase: "seed",
	requests: 0,
}

describe("formatProgressLine", () => {
	it("writes logfmt, quoting a value that is empty or holds a space, quote or backslash", () => {
		const line = formatProgressLine(settled, AT + 5)
		expect(line.startsWith("ts=2030-01-01T00:00:00.005Z status=ok done=1 total=2 phase=test entity=items")).toBe(true)
		expect(line).toContain('msg="page two"')
		expect(line).toContain('req_id="" last_at=2030-01-01T00:00:00.000Z last_ms=4')
		expect(line.endsWith("idle_ms=5 elapsed_ms=50")).toBe(true)
		expect(formatProgressLine({ ...settled, message: 'a"b\\c=d' }, AT)).toContain('msg="a\\"b\\\\c=d"')
		expect(formatProgressLine(waiting)).toContain("status=in_flight")
	})
})

describe("formatProgressTsv", () => {
	it("writes the same columns, tab-separated, led by the instant in ms", () => {
		const row = formatProgressTsv(waiting, AT + 9).split("\t")
		expect(row).toEqual([
			String(AT + 9),
			"in_flight",
			"-",
			"-",
			"seed",
			"-",
			"-",
			"-",
			"0",
			"0",
			"POST",
			"/b",
			"-",
			"-",
			"2030-01-01T00:00:00.000Z",
			"-",
			"-",
			"-",
			"9",
			"0",
		])
		expect(formatProgressTsv(settled).split("\t")).toHaveLength(20)
	})
})

describe("formatProgressJsonl", () => {
	it("writes the same event as JSON, with null for every dash", () => {
		expect(JSON.parse(formatProgressJsonl(waiting, AT + 9))).toEqual({
			check: null,
			done: null,
			elapsed_ms: 0,
			entity: null,
			find: 0,
			http: null,
			idle_ms: 9,
			last_at: "2030-01-01T00:00:00.000Z",
			last_ms: null,
			method: "POST",
			msg: null,
			path: "/b",
			phase: "seed",
			req: 0,
			req_b: null,
			req_id: null,
			res_b: null,
			status: "in_flight",
			total: null,
			ts: "2030-01-01T00:00:00.009Z",
			ts_ms: AT + 9,
		})
	})

	it("keeps the order of its keys, and numbers as numbers", () => {
		const event = JSON.parse(
			formatProgressJsonl(
				{ ...settled, last: { ...(settled.last as NonNullable<ProgressSnapshot["last"]>), requestId: "r" } },
				AT,
			),
		)
		expect(Object.keys(event).slice(0, 4)).toEqual(["check", "done", "elapsed_ms", "entity"])
		expect([event.http, event.req_b, event.res_b, event.last_ms, event.req_id, event.total]).toEqual([
			200,
			10,
			20,
			4,
			"r",
			2,
		])
		expect(JSON.parse(formatProgressJsonl(settled, AT)).req_id).toBeNull()
		const unanswered: ProgressSnapshot = { elapsedMs: 0, findings: 0, phase: "test", requests: 1 }
		expect(JSON.parse(formatProgressJsonl(unanswered)).http).toBeNull()
		expect(typeof JSON.parse(formatProgressJsonl(settled)).ts_ms).toBe("number")
	})
})
