import { describe, expect, it } from "vitest"
import { operation } from "../../../spec/graph/__fixtures__/operations.ts"
import type { OperationModel } from "../../../spec/graph/types.ts"
import { isReadMethod, isUntested, placementOf, targetPlan } from "./operation.ts"
import type { OperationContext, WriteTarget } from "./operation-context.ts"

const op = (method: string, path = "/notes/{note_id}"): OperationModel => ({
	...operation({ method, operationId: "notes.update", path }),
})

const target: WriteTarget = {
	current: { id: "n1" },
	entity: "note",
	id: "n1",
	owner: "alpha",
	params: { note_id: "n1" },
	path: "/notes/n1",
}

describe("isReadMethod", () => {
	it("reads GET, HEAD and QUERY as reads, whatever their case, and every other method as a write", () => {
		for (const method of ["GET", "head", "QUERY"]) expect(isReadMethod(op(method))).toBe(true)
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(isReadMethod(op(method))).toBe(false)
	})
})

describe("targetPlan", () => {
	it("hands over the record the stage found, and stands down without one", () => {
		const ctx = { operation: op("PATCH"), target } as OperationContext
		expect(targetPlan(ctx)).toEqual({ ok: true, value: target })
		expect(targetPlan({ operation: op("PATCH") } as OperationContext)).toEqual({
			needs: "a record this run created that notes.update can be sent to",
			ok: false,
		})
	})

	it("stands down with the stage's own reason when it gives one", () => {
		const ctx = { operation: op("DELETE"), untargeted: "a create for note" } as OperationContext
		expect(targetPlan(ctx)).toEqual({ needs: "a create for note", ok: false })
	})
})

describe("isUntested", () => {
	it("tells a refusal from a credential", () => {
		expect(isUntested({ untested: "static recipes cannot issue a dedicated credential" })).toBe(true)
		expect(isUntested({ value: "v" })).toBe(false)
	})
})

describe("placementOf", () => {
	it("places a collection read before the lanes, an item read and a write after them", () => {
		expect(placementOf({}, op("GET", "/notes"))).toBe("read")
		expect(placementOf({}, op("GET", "/"))).toBe("read")
		expect(placementOf({}, op("HEAD", "/projects/{project_id}/notes"))).toBe("read")
		expect(placementOf({}, op("GET"))).toBe("item-read")
		expect(placementOf({}, op("PATCH"))).toBe("write")
		expect(placementOf({}, op("POST", "/notes"))).toBe("write")
	})

	it("places every probe of a check that changes a credential with the writes, alone and in order", () => {
		expect(placementOf({ mutatesCredentials: true }, op("GET", "/notes"))).toBe("write")
	})
})
