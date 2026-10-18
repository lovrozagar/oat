import { describe, expect, it } from "vitest"
import { isSseFrameList, parseSse, SseParser, sseEvents, sseFramesOf } from "./sse.ts"

describe("SseParser", () => {
	it("splits frames across chunks the way a browser does", () => {
		const parser = new SseParser()
		parser.push('event: progress\r\ndata: {"n"')
		parser.push(":1}\n\n: a comment\nretry\ndata:plain\ndata:  two\n\n\n")
		parser.push("event: complete\ndata: [1]")
		expect(parser.finish()).toEqual([
			{ data: { n: 1 }, event: "progress", raw: '{"n":1}' },
			{ data: "plain\n two", event: "message", raw: "plain\n two" },
			{ data: [1], event: "complete", raw: "[1]" },
		])
	})

	it("keeps data that only looks like JSON as the raw string, and drops a frame with no data", () => {
		expect(parseSse("event: lone\n\ndata: {broken\n\n")).toEqual([
			{ data: "{broken", event: "message", raw: "{broken" },
		])
	})
})

describe("sseEvents", () => {
	it("reads a stream body, and passes over a body that is not one", () => {
		expect(sseEvents("data: x\n\n")).toEqual([{ data: "x", event: "message", raw: "x" }])
		expect(sseEvents("plain text")).toBeNull()
		expect(sseEvents({ id: 1 })).toBeNull()
	})

	it("takes frames already parsed, and drops their raw copy again for a transcript", () => {
		const events = sseEvents([
			{ data: { id: 1 }, event: "start" },
			{ data: "done", event: "complete" },
		])
		expect(events).toEqual([
			{ data: { id: 1 }, event: "start", raw: '{"id":1}' },
			{ data: "done", event: "complete", raw: "done" },
		])
		expect(sseFramesOf(events ?? [])).toEqual([
			{ data: { id: 1 }, event: "start" },
			{ data: "done", event: "complete" },
		])
	})

	it("counts only a non-empty list of named frames as frames", () => {
		expect(isSseFrameList([])).toBe(false)
		expect(isSseFrameList("data: x")).toBe(false)
		expect(isSseFrameList([null])).toBe(false)
		expect(isSseFrameList([{ event: 1, data: 1 }])).toBe(false)
		expect(isSseFrameList([{ event: "e" }])).toBe(false)
		expect(isSseFrameList([{ data: null, event: "e" }])).toBe(true)
	})
})
