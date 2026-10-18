import { describe, expect, it } from "vitest"
import type { FenceRequest } from "../config/types/hooks.ts"
import { Fence } from "../runtime/fence.ts"
import { fenceAsker } from "./fence.ts"

describe("fenceAsker", () => {
	it("asks with the headers as they are at the time of the ask, and the request's purpose and operation", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => {
			asked.push(request)
			return { allow: true }
		})
		const headers: Record<string, string> = { a: "1" }
		const ask = fenceAsker(fence, { headers, operationId: "row.list", purpose: "probe" })
		await ask(new URL("http://api.test/rows"), "GET", undefined)
		headers.b = "2"
		await ask(new URL("http://cdn.test/x"), "GET", { n: 1 })
		expect(asked).toEqual([
			{
				body: undefined,
				headers: { a: "1" },
				method: "GET",
				operationId: "row.list",
				phase: "probe",
				url: "http://api.test/rows",
			},
			{
				body: { n: 1 },
				headers: { a: "1", b: "2" },
				method: "GET",
				operationId: "row.list",
				phase: "probe",
				url: "http://cdn.test/x",
			},
		])
	})

	it("calls an unnamed purpose a request, names no operation it lacks, and raises a refusal", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => {
			asked.push(request)
			return { allow: false, reason: "no deletes" }
		})
		const ask = fenceAsker(fence, { headers: {}, operationId: undefined, purpose: undefined })
		await expect(ask(new URL("http://api.test/rows/1"), "DELETE", undefined)).rejects.toThrow(/no deletes/)
		expect(asked[0]).toEqual({
			body: undefined,
			headers: {},
			method: "DELETE",
			phase: "request",
			url: "http://api.test/rows/1",
		})
	})

	it("lets everything through without a fence", async () => {
		const ask = fenceAsker(undefined, { headers: {}, operationId: undefined, purpose: undefined })
		await expect(ask(new URL("http://api.test/"), "DELETE", undefined)).resolves.toBeUndefined()
	})
})
