import { describe, expect, it } from "vitest"
import { progressFields, STALL_MS } from "./fields.ts"
import type { ProgressLast, ProgressSnapshot } from "./types.ts"

const AT = Date.parse("2030-01-01T00:00:00Z")
const base: ProgressSnapshot = { elapsedMs: 1234.6, findings: 2, phase: "test", requests: 9 }
const last: ProgressLast = {
	at: AT,
	durationMs: 40,
	method: "GET",
	requestBytes: 100,
	requestId: "rid-1",
	responseBytes: 300,
	status: 200,
	url: "http://h.test/v1/items?page=2",
}

describe("progressFields, the run", () => {
	it("dashes what the snapshot does not say, and rounds elapsed time, never below zero", () => {
		expect(progressFields({ ...base, elapsedMs: -5 }, AT)).toMatchObject({
			check: "-",
			done: "-",
			elapsed_ms: "0",
			entity: "-",
			find: "2",
			msg: "-",
			phase: "test",
			req: "9",
			total: "-",
		})
		const full = { ...base, check: "list.pages", entity: "items", entityIndex: 1, entityTotal: 3, message: "seeding" }
		expect(progressFields(full, AT)).toMatchObject({
			check: "list.pages",
			done: "1",
			elapsed_ms: "1235",
			entity: "items",
			msg: "seeding",
			total: "3",
		})
	})
})

describe("progressFields, the last call", () => {
	it("dashes every call column before the first call", () => {
		const fields = progressFields(base, AT)
		expect([fields.http, fields.method, fields.path, fields.req_id, fields.idle_ms, fields.status]).toEqual([
			"-",
			"-",
			"-",
			"-",
			"-",
			"ok",
		])
	})

	it("describes the last completed call, and reads a long silence as a stall", () => {
		expect(progressFields({ ...base, last }, AT + 10)).toMatchObject({
			http: "200",
			idle_ms: "10",
			last_at: "2030-01-01T00:00:00.000Z",
			last_ms: "40",
			method: "GET",
			path: "/v1/items?page=2",
			req_b: "100",
			req_id: "rid-1",
			res_b: "300",
			status: "ok",
		})
		expect(progressFields({ ...base, last }, AT + STALL_MS).status).toBe("stall")
		expect(progressFields({ ...base, last: { ...last, network: "dns" } }, AT + STALL_MS).status).toBe("network")
		expect(progressFields({ ...base, last: { ...last, url: "not a url" } }, AT - 5)).toMatchObject({
			idle_ms: "0",
			path: "not a url",
		})
	})
})

describe("progressFields, a call on the wire", () => {
	it("counts idle time from when the call started, with no answer yet", () => {
		const inflight = { at: AT, method: "POST", requestBytes: 12, requestId: "rid-2", url: "http://h.test/v1/items" }
		expect(progressFields({ ...base, inflight, last }, AT + 7)).toMatchObject({
			http: "-",
			idle_ms: "7",
			last_at: "2030-01-01T00:00:00.000Z",
			last_ms: "-",
			method: "POST",
			path: "/v1/items",
			req_b: "12",
			req_id: "rid-2",
			res_b: "-",
			status: "in_flight",
		})
		const bare = progressFields({ ...base, inflight: { at: AT, method: "GET", requestId: "", url: "x" } }, AT - 1)
		expect([bare.req_id, bare.req_b, bare.idle_ms, bare.path]).toEqual(["-", "-", "0", "x"])
		expect(progressFields({ ...base, inflight: { at: AT, method: "GET", url: "x" } }, AT).req_id).toBe("-")
	})
})
