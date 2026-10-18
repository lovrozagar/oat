import { describe, expect, it } from "vitest"
import { type CreatedIdSource, createdRecordOf, resolveCreatedId } from "./created-id.ts"

const NONE: CreatedIdSource = { createdIdFrom: null, recordPath: null }

describe("createdRecordOf", () => {
	it("is the top level unless an envelope holds more of what was sent", () => {
		const sent = { flag: true, name: "a", tags: ["x"] }
		expect(createdRecordOf({ data: { ID: 9, flag: true, name: "a" }, id: 9, success: true }, "ID", sent)).toEqual({
			ID: 9,
			flag: true,
			name: "a",
		})
		expect(createdRecordOf({ data: { other: 1 }, id: 1, name: "a" }, "id", sent)).toEqual({
			data: { other: 1 },
			id: 1,
			name: "a",
		})
		expect(createdRecordOf([1], "id", sent)).toEqual({})
		expect(createdRecordOf({ data: { name: "a" } }, "id", "not a record")).toEqual({ data: { name: "a" } })
	})

	it("gives an enveloped record the envelope's identity, or its id, when it lacks one", () => {
		const sent = { name: "a" }
		expect(createdRecordOf({ data: { name: "a" }, row_id: "r1" }, "row_id", sent)).toEqual({ name: "a", row_id: "r1" })
		expect(createdRecordOf({ id: 4, item: { name: "a" } }, "row_id", sent)).toEqual({ name: "a", row_id: 4 })
		expect(createdRecordOf({ id: null, result: { name: "a" } }, "row_id", sent)).toEqual({ name: "a" })
	})
})

const resolve = (body: unknown, source = NONE, identity = "id") =>
	resolveCreatedId({ body, entity: "row", identity, sent: { name: "a" }, source })

describe("resolveCreatedId", () => {
	it("trusts a declared id, then the answer's own identity", () => {
		const declared = { createdIdFrom: "$.meta.key", recordPath: null }
		expect(resolve({ id: 1, meta: { key: "k" } }, declared)).toEqual({ id: "k", trusted: true, value: "k" })
		expect(resolve({ id: 1, meta: {} }, declared)).toEqual({ id: "1", trusted: true, value: 1 })
	})

	it("takes the declared record's identity as a candidate", () => {
		const source = { createdIdFrom: null, recordPath: "$.payload" }
		expect(resolve({ payload: { id: "p1" } }, source)).toEqual({ id: "p1", trusted: false, value: "p1" })
		expect(resolve({ payload: "p1", row_id: "r2" }, source)).toEqual({ id: "r2", trusted: false, value: "r2" })
		expect(resolve({ payload: {}, row_id: "r3" }, source)).toEqual({ id: "r3", trusted: false, value: "r3" })
	})

	it("falls back to an enveloped record, then to a conventional key anywhere in the answer", () => {
		expect(resolve({ data: { name: "a", uid: "u1" }, ok: true }, NONE, "uid")).toEqual({
			id: "u1",
			trusted: false,
			value: "u1",
		})
		expect(resolve([{ row_id: "r4" }])).toEqual({ id: "r4", trusted: false, value: "r4" })
		expect(resolve({ ok: true })).toBeUndefined()
	})
})
