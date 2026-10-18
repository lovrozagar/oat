import { describe, expect, it } from "vitest"
import { BASE, exchange, reportOf } from "./__fixtures__/report.ts"
import { costByCheck, latency, utf8Total } from "./traffic.ts"

describe("utf8Total", () => {
	it("sums one side of the transcript", () => {
		const transcript = [
			exchange({ requestBytes: 3, responseBytes: 10 }),
			exchange({ requestBytes: 4, responseBytes: 1 }),
		]
		expect(utf8Total(transcript, "request")).toBe(7)
		expect(utf8Total(transcript, "response")).toBe(11)
	})
})

describe("latency", () => {
	it("is null with no requests", () => {
		expect(latency([])).toBeNull()
	})

	it("reports the percentiles and where the slowest request went", () => {
		const transcript = [10, 30, 20, 40].map((durationMs, i) =>
			exchange({ durationMs, method: i === 3 ? "POST" : "GET", url: `${BASE}/v1/slow/${i}?q=1` }),
		)
		expect(latency(transcript)).toEqual({ max: 40, p50: 30, p95: 40, slowest: { method: "POST", path: "/v1/slow/3" } })
		expect(latency([exchange({ durationMs: 5 })])).toEqual({
			max: 5,
			p50: 5,
			p95: 5,
			slowest: { method: "GET", path: "/v1/rows" },
		})
	})
})

describe("costByCheck", () => {
	it("counts each check's requests and time, costliest first", () => {
		const input = reportOf(
			{
				checkTimings: [
					{ check: "b", entity: "row", ms: 5 },
					{ check: "c", entity: "row", ms: 9 },
					{ check: "b", entity: "other", ms: 5 },
					{ check: "d", entity: "row", ms: 9 },
				],
			},
			[exchange({ check: "a" }), exchange({ check: "a" }), exchange({ check: "b" }), exchange()],
		)
		expect(costByCheck(input)).toEqual([
			{ check: "a", ms: 0, requests: 2 },
			{ check: "b", ms: 10, requests: 1 },
			{ check: "c", ms: 9, requests: 0 },
			{ check: "d", ms: 9, requests: 0 },
		])
	})

	it("is empty when nothing was attributed to a check", () => {
		expect(costByCheck(reportOf({}, [exchange()]))).toEqual([])
	})
})
