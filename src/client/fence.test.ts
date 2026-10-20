import { describe, expect, it } from "vitest"
import type { FenceRequest } from "../config/types/hooks.ts"
import { Fence } from "../runtime/fence.ts"
import { fenceAsker } from "./fence.ts"
import { NOTHING_PLACED, type Placement } from "./placing.ts"

describe("fenceAsker", () => {
	it("asks with the headers as they are at the time of the ask, and the request's purpose and operation", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => {
			asked.push(request)
			return { allow: true }
		})
		const headers: Record<string, string> = { a: "1" }
		const ask = fenceAsker(fence, { headers, operationId: "row.list", placement: NOTHING_PLACED, purpose: "probe" })
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
})

describe("fenceAsker: defaults and refusals", () => {
	it("calls an unnamed purpose a request, names no operation it lacks, and raises a refusal", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => {
			asked.push(request)
			return { allow: false, reason: "no deletes" }
		})
		const ask = fenceAsker(fence, {
			headers: {},
			operationId: undefined,
			placement: NOTHING_PLACED,
			purpose: undefined,
		})
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
		const ask = fenceAsker(undefined, {
			headers: {},
			operationId: undefined,
			placement: NOTHING_PLACED,
			purpose: undefined,
		})
		await expect(ask(new URL("http://api.test/"), "DELETE", undefined)).resolves.toBeUndefined()
	})
})

describe("fenceAsker: the credential", () => {
	it("names who sends, under which schemes, and whether the value is forged; nothing for an anonymous request", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => {
			asked.push(request)
			return { allow: true }
		})
		const bearer = { cookies: {}, headers: { Authorization: "Bearer t" }, query: {} }
		const sending: Placement = { forged: false, principal: "alpha", schemes: ["jwt"], sends: { jwt: bearer } }
		const forged: Placement = { forged: true, schemes: ["jwt"], sends: { jwt: bearer } }
		for (const placement of [sending, forged, NOTHING_PLACED]) {
			const ask = fenceAsker(fence, { headers: {}, operationId: undefined, placement, purpose: undefined })
			await ask(new URL("http://api.test/me"), "GET", undefined)
		}
		const who = asked.map(({ principal, schemes, forged: isForged }) => ({ forged: isForged, principal, schemes }))
		expect(who).toEqual([
			{ forged: undefined, principal: "alpha", schemes: ["jwt"] },
			{ forged: true, principal: undefined, schemes: ["jwt"] },
			{ forged: undefined, principal: undefined, schemes: undefined },
		])
		expect(asked.map((request) => Object.keys(request).length)).toEqual([7, 7, 5])
	})
})
