import { describe, expect, it } from "vitest"
import { inspectStreamAsync, resolveAsyncId } from "../../src/runtime/async.ts"
import { isSseFrameList, parseSse, SseParser, sseEvents, sseFramesOf } from "../../src/runtime/sse.ts"
import { documentsEventStream } from "../../src/spec/collection/responses.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OperationObject } from "../../src/spec/types.ts"
import { BATCH_ONLY_STREAM, COMPLETE_STREAM, SSE_ASYNC as ASYNC, streamSpec } from "../support/sse-fixtures.ts"

function parsesMixedFrames(): void {
	const text = [
		": keep-alive",
		"data: hello",
		"",
		"event: items",
		"data: [1, 2]",
		"",
		"data: {not json",
		"",
		"event: batch\r",
		'data: {"batch_id":"crlf"}\r',
		"\r",
	].join("\n")
	const events = parseSse(text)
	expect(events).toEqual([
		{ data: "hello", event: "message", raw: "hello" },
		{ data: [1, 2], event: "items", raw: "[1, 2]" },
		{ data: "{not json", event: "message", raw: "{not json" },
		{ data: { batch_id: "crlf" }, event: "batch", raw: '{"batch_id":"crlf"}' },
	])
}

function acceptsOnlySse(): void {
	expect(sseEvents({ batch_id: "x" })).toBeNull()
	expect(sseEvents("not a stream")).toBeNull()
	expect(sseEvents("data: x\n\n")).toEqual([{ data: "x", event: "message", raw: "x" }])
	expect(sseEvents([])).toBeNull()
	expect(sseEvents([{ id: "1" }])).toBeNull()
	expect(sseEvents(null)).toBeNull()
	expect(sseEvents([null])).toBeNull()
	expect(sseEvents([1])).toBeNull()
	expect(sseEvents([{ data: "x", event: 1 }])).toBeNull()
	expect(sseEvents([{ event: "x" }])).toBeNull()
	expect(isSseFrameList("no")).toBe(false)
	expect(isSseFrameList([{ event: "batch", data: { n: 1 } }])).toBe(true)
	expect(sseEvents([{ event: "batch", data: { batch_id: "b_1" } }])).toEqual([
		{ data: { batch_id: "b_1" }, event: "batch", raw: '{"batch_id":"b_1"}' },
	])
	expect(sseEvents([{ data: "hello", event: "message" }])?.[0]?.raw).toBe("hello")
	expect(sseFramesOf([{ data: { n: 1 }, event: "batch", raw: '{"n":1}' }])).toEqual([
		{ data: { n: 1 }, event: "batch" },
	])
}

describe("SSE frames", () => {
	it("parses event/data frames and JSON data", () => {
		const events = parseSse(COMPLETE_STREAM)
		expect(events.map((e) => e.event)).toEqual(["batch", "complete"])
		expect(events[0]?.data).toEqual({ batch_id: "b_1" })
		expect(events[1]?.data).toEqual({ status: "complete" })
	})

	it("parses comments, CRLF, default event, arrays, and broken JSON", parsesMixedFrames)

	it("joins multiline data and skips empty frames", () => {
		const events = parseSse('event: note\ndata: {"a":1}\ndata: extra\n\nevent: unused\n\n')
		expect(events).toHaveLength(1)
		expect(events[0]).toEqual({ data: '{"a":1}\nextra', event: "note", raw: '{"a":1}\nextra' })
	})

	it("sseEvents only accepts a string that looks like SSE", acceptsOnlySse)

	it("parses incrementally across chunk boundaries and leftover lines", () => {
		const parser = new SseParser()
		parser.push("id: 1\n")
		parser.push("data: hel")
		parser.push("lo\n\n")
		parser.push("event: note\ndata: last")
		expect(parser.finish()).toEqual([
			{ data: "hello", event: "message", raw: "hello" },
			{ data: "last", event: "note", raw: "last" },
		])
		expect(parseSse("data: x")).toEqual([{ data: "x", event: "message", raw: "x" }])
		expect(parseSse("event: ping\n\n")).toEqual([])
		expect(parseSse("data\n\n")).toEqual([{ data: "", event: "message", raw: "" }])
		expect(parseSse("retry: 1000\n\n")).toEqual([])
	})

	it("resolves idFrom against event JSON, not the raw string", () => {
		expect(resolveAsyncId(COMPLETE_STREAM, "$.batch_id")).toBe("b_1")
		expect(resolveAsyncId({ batch_id: "from-object" }, "$.batch_id")).toBe("from-object")
		expect(resolveAsyncId(BATCH_ONLY_STREAM, "$.missing")).toBeUndefined()
		const viewed = inspectStreamAsync(COMPLETE_STREAM, ASYNC)
		expect(viewed?.id).toBe("b_1")
		expect(viewed?.terminal).toEqual({ status: "complete" })
	})

	it("takes the first idFrom hit and treats named error or until as terminal", () => {
		const twoIds = 'event: batch\ndata: {"batch_id":"first"}\n\nevent: batch\ndata: {"batch_id":"second"}\n\n'
		expect(resolveAsyncId(twoIds, "$.batch_id")).toBe("first")

		const errorFrame = 'event: error\ndata: {"status":"failed","batch_id":"b_1"}\n\n'
		expect(inspectStreamAsync(errorFrame, ASYNC)?.terminal).toEqual({ batch_id: "b_1", status: "failed" })

		const untilOnly = 'event: progress\ndata: {"batch_id":"b_1","status":"complete"}\n\n'
		expect(inspectStreamAsync(untilOnly, ASYNC)?.terminal).toEqual({ batch_id: "b_1", status: "complete" })
		expect(inspectStreamAsync("hello", ASYNC)).toBeNull()
	})
})

const op = (responses: OperationObject["responses"]): OperationObject => ({
	operationId: "op",
	...(responses === undefined ? {} : { responses }),
})

describe("documentsEventStream", () => {
	it("is true for any success response that lists text/event-stream", () => {
		expect(documentsEventStream(op({ "200": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "201": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "202": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "2XX": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ default: { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(
			true,
		)
	})

	it("is false when only an error response or JSON success lists the type", () => {
		expect(documentsEventStream(op({ "400": { content: { "text/event-stream": {} }, description: "no" } }))).toBe(false)
		expect(documentsEventStream(op({ "200": { content: { "application/json": {} }, description: "ok" } }))).toBe(false)
		expect(streamSpec({ async: false }).paths?.["/v1/extract/stream"]).toBeDefined()
		const model = buildModel(dereference(streamSpec({ async: true })).doc)
		expect(model.byOperationId.get("extract.stream")?.eventStream).toBe(true)
		expect(model.byOperationId.get("batch.create")?.eventStream).toBe(false)
	})
})
