import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { pathTo, proveFromTranscript } from "./evidence.ts"
import { GradeLedger } from "./grades.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"

const ok = { "200": { description: "ok" } }
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

const spec: OpenApiDocument = {
	info: { title: "evidence", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/rows": {
			get: { operationId: "row.list", responses: ok },
			post: { operationId: "row.create", responses: ok },
		},
		"/v1/rows/{id}": {
			delete: { operationId: "row.remove", parameters: [param("id")], responses: ok },
			get: { operationId: "row.get", parameters: [param("id")], responses: ok },
		},
		"/v1/tables/{table_id}": {
			get: { operationId: "table.get", parameters: [param("table_id")], responses: ok },
		},
		"/v1/tables/{table_id}/columns/{col_id}": {
			delete: { operationId: "column.remove", parameters: [param("table_id"), param("col_id")], responses: ok },
		},
	},
} as OpenApiDocument

const BASE = "http://api.test"
const COLUMN = "col_amount_2"
const ROW = "row_abc123"

interface Shape {
	body?: unknown
	sent?: unknown
	op?: string
	status?: number
	purpose?: string
	url?: string
}

function exchange(seq: number, method: string, path: string, shape: Shape = {}): Exchange {
	return {
		at: seq,
		method,
		requestBody: shape.sent,
		responseBody: shape.body,
		seq,
		status: shape.status ?? 200,
		url: shape.url ?? `${BASE}${path}`,
		...(shape.op === undefined ? {} : { operationId: shape.op }),
		...(shape.purpose === undefined ? {} : { purpose: shape.purpose }),
	} as Exchange
}

const table = (columns: string[]) => ({ columns_json: columns.map((id) => ({ id })), id: "tbl_1" })

async function evidenceFor(operation: string, transcript: Exchange[], grades = new GradeLedger()) {
	grades.graded([operation], "some.check")
	let hydrations = 0
	const hydrate = async (e: Exchange) => {
		hydrations += 1
		return e
	}
	const client = { hydrate, transcript } as unknown as Client
	await proveFromTranscript({ client, grades, model: buildModel(dereference(spec).doc) })
	return { evidence: grades.evidence.get(operation), hydrations }
}

describe("delete evidence through an ancestor read", () => {
	it("is observed when the ancestor held the id before and lacks it after", async () => {
		const { evidence } = await evidenceFor("column.remove", [
			exchange(1, "GET", "/v1/tables/tbl_1", { body: table(["col_amount", COLUMN]), op: "table.get" }),
			exchange(2, "DELETE", `/v1/tables/tbl_1/columns/${COLUMN}`, { op: "column.remove" }),
			exchange(3, "GET", "/v1/tables/tbl_1", { body: table(["col_amount"]), op: "table.get" }),
		])
		expect(evidence).toEqual({ call: 2, observation: { absent: true, path: "$", seq: 3, value: COLUMN } })
	})

	it("is not observed when the ancestor never held the id, nor from reads that cannot show it", async () => {
		const { evidence } = await evidenceFor("column.remove", [
			exchange(1, "GET", "/v1/tables/tbl_1", { body: table(["col_amount"]), op: "table.get" }),
			exchange(2, "GET", "/v1/other", { body: table([COLUMN]) }),
			exchange(3, "GET", "/v1/tables/tbl_1", { body: table([COLUMN]), status: 500 }),
			exchange(4, "DELETE", `/v1/tables/tbl_1/columns/${COLUMN}`, { op: "column.remove" }),
			exchange(5, "POST", "/v1/tables/tbl_1", { body: {} }),
			exchange(6, "GET", "/v1/elsewhere", { body: {} }),
			exchange(7, "GET", "/v1/tables/tbl_1", { body: table([COLUMN]) }),
			exchange(8, "GET", "/v1/tables/tbl_1", { body: table(["col_amount"]), op: "table.get" }),
		])
		expect(evidence).toEqual({ call: 4 })
	})
})

describe("delete evidence through its own route", () => {
	it("is a later read of the item answering 404 or 410", async () => {
		for (const status of [404, 410]) {
			const { evidence } = await evidenceFor("row.remove", [
				exchange(1, "DELETE", `/v1/rows/${ROW}`, { op: "row.remove" }),
				exchange(2, "GET", `/v1/rows/${ROW}`, { status }),
			])
			expect(evidence).toEqual({ call: 1, observation: { seq: 2, status } })
		}
	})

	it("is a later listing that no longer holds the id, after one that still does", async () => {
		const { evidence } = await evidenceFor("row.remove", [
			exchange(1, "DELETE", `/v1/rows/${ROW}`, { op: "row.remove" }),
			exchange(2, "GET", "/v1/rows", { body: { items: [{ id: ROW }] } }),
			exchange(3, "GET", "/v1/rows", { body: { items: [] } }),
		])
		expect(evidence).toEqual({ call: 1, observation: { absent: true, path: "$", seq: 3, value: ROW } })
	})

	it("cannot name an id from a path ending in a slash, and reads one that is no URL whole", async () => {
		const trailing = await evidenceFor("row.remove", [
			exchange(1, "DELETE", "/v1/rows/", { op: "row.remove" }),
			exchange(2, "GET", "/v1/rows", { body: { items: [] } }),
		])
		expect(trailing.evidence).toEqual({ call: 1 })
		const bare = await evidenceFor("row.remove", [
			exchange(1, "DELETE", "", { op: "row.remove", url: "rows" }),
			exchange(2, "GET", "", { body: { items: [] }, url: "" }),
		])
		expect(bare.evidence).toEqual({ call: 1, observation: { absent: true, path: "$", seq: 2, value: "rows" } })
	})
})

describe("read evidence", () => {
	it("is a value an earlier write put into the world, found in the read", async () => {
		const { evidence } = await evidenceFor("row.get", [
			exchange(1, "GET", "/v1/rows", { body: { id: "row_unrelated" } }),
			exchange(2, "POST", "/v1/rows", { body: { id: "row_failed" }, status: 500 }),
			exchange(3, "POST", "/v1/rows", { body: { id: ROW } }),
			exchange(4, "GET", `/v1/rows/${ROW}`, { body: { data: { id: ROW } }, op: "row.get" }),
		])
		expect(evidence).toEqual({ call: 4, observation: { path: "$.data.id", seq: 4, value: ROW } })
	})

	it("keeps only the call when no earlier write shows in it", async () => {
		const { evidence } = await evidenceFor("row.get", [
			exchange(1, "POST", "/v1/rows", { body: { id: ROW } }),
			exchange(2, "GET", `/v1/rows/${ROW}`, { body: { id: "row_other" }, op: "row.get" }),
		])
		expect(evidence).toEqual({ call: 2 })
	})
})

describe("write evidence", () => {
	it("is a later read holding an id the call returned or a string it sent", async () => {
		const sent = { meta: { note: "a long note" }, tags: ["tag"] }
		const { evidence } = await evidenceFor("row.create", [
			exchange(1, "POST", "/v1/rows", {
				body: { id: ROW, name: "short", owner_id: "usr_123456", title: "not an id" },
				op: "row.create",
				sent,
			}),
			exchange(2, "GET", "/v1/rows", { body: [ROW], status: 503 }),
			exchange(3, "GET", "/v1/rows", { body: [{ x: 1 }, ["a long note"]] }),
		])
		expect(evidence).toEqual({ call: 1, observation: { path: "$[*][*]", seq: 3, value: "a long note" } })
	})

	it("keeps only the call when it put nothing distinctive into the world", async () => {
		const { evidence } = await evidenceFor("row.create", [
			exchange(1, "POST", "/v1/rows", { body: { a: { b: { c: { d: { e: { id: ROW } } } } } }, op: "row.create" }),
			exchange(2, "GET", "/v1/rows", { body: [ROW] }),
		])
		expect(evidence).toEqual({ call: 1 })
	})

	it("ignores teardown reads, and reads each body once across calls", async () => {
		const { evidence, hydrations } = await evidenceFor("row.create", [
			exchange(1, "POST", "/v1/rows", { body: { id: ROW }, op: "row.create" }),
			exchange(2, "POST", "/v1/rows", { body: { id: "row_second" }, op: "row.create" }),
			exchange(3, "GET", "/v1/rows", { body: [{ id: "row_none" }] }),
			exchange(4, "GET", "/v1/rows", { body: [{ id: ROW }], purpose: "teardown" }),
		])
		expect(evidence).toEqual({ call: 2 })
		expect(hydrations).toBe(3)
	})
})

describe("which operations are proven", () => {
	it("skips one never graded, one already observed, and one with no successful call", async () => {
		const grades = new GradeLedger()
		grades.prove("row.list", { call: 9, observation: { seq: 9, status: 404 } })
		grades.graded(["row.list"], "some.check")
		const { evidence } = await evidenceFor(
			"row.get",
			[
				exchange(1, "GET", `/v1/rows/${ROW}`, { op: "row.get", status: 404 }),
				exchange(2, "GET", "/v1/rows", { op: "row.list" }),
			],
			grades,
		)
		expect(evidence).toBeUndefined()
		expect(grades.evidence.get("row.list")).toEqual({ call: 9, observation: { seq: 9, status: 404 } })
		expect(grades.evidence.has("row.create")).toBe(false)
	})
})

describe("pathTo", () => {
	it("names a string inside arrays, and gives up past its depth", () => {
		expect(pathTo([["x"], [{ a: "v" }]], "v")).toBe("$[*][*].a")
		expect(pathTo([1, 2], "v")).toBeNull()
		expect(pathTo({ a: { b: { c: { d: { e: { f: { g: { h: "v" } } } } } } } }, "v")).toBeNull()
	})
})
