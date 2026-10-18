import { describe, expect, it } from "vitest"
import type { FenceRequest } from "../config/types/hooks.ts"
import { Fence, FencedError } from "./fence.ts"

const request = (over: Partial<FenceRequest> = {}): FenceRequest => ({
	body: undefined,
	headers: {},
	method: "DELETE",
	phase: "teardown",
	url: "http://api.test/rows/1",
	...over,
})

describe("Fence", () => {
	it("lets an allowed request go and keeps no record of it", async () => {
		const fence = new Fence(() => ({ allow: true }))
		await expect(fence.check(request())).resolves.toBeUndefined()
		expect(fence.fenced).toEqual([])
	})

	it("refuses a request with a FencedError, and keeps every refusal for the report", async () => {
		const fence = new Fence((sent) =>
			Promise.resolve(sent.method === "DELETE" ? { allow: false, reason: "no deletes" } : { allow: true }),
		)
		const refusal = fence.check(request({ operationId: "row.delete" }))
		await expect(refusal).rejects.toBeInstanceOf(FencedError)
		await expect(refusal).rejects.toThrow("fenced: no deletes (DELETE http://api.test/rows/1)")
		await expect(fence.check(request({ phase: "seed" }))).rejects.toThrow(/no deletes/)
		expect(fence.fenced).toEqual([
			{
				method: "DELETE",
				operationId: "row.delete",
				phase: "teardown",
				reason: "no deletes",
				url: "http://api.test/rows/1",
			},
			{ method: "DELETE", phase: "seed", reason: "no deletes", url: "http://api.test/rows/1" },
		])
	})
})
