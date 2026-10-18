import { describe, expect, it } from "vitest"
import { answeredId, createdId, listedIds, receiptId, returnedId } from "./proven-id.ts"

describe("proven ids", () => {
	it("are what an answer carried, as a string", () => {
		expect(answeredId({ responseBody: { data: { row_id: 7 } } }, ["row_id", "id"])).toBe("7")
		expect(answeredId({ responseBody: { ok: true } }, ["id"])).toBeUndefined()
		expect(returnedId({ id: 3 }, "id")).toBe("3")
		expect(returnedId({ id: { nested: 1 } }, "id")).toBeUndefined()
		expect(createdId("r1")).toBe("r1")
		expect(createdId(null)).toBeUndefined()
		expect(listedIds(["a", "b"])).toEqual(["a", "b"])
	})

	it("read a job id from an async receipt or its stream", () => {
		expect(receiptId({ job: { id: "j1" } }, "$.job.id")).toBe("j1")
		expect(receiptId('event: start\ndata: {"id":"j2"}\n\n', "$.id")).toBe("j2")
		expect(receiptId({}, "$.id")).toBeUndefined()
	})
})
