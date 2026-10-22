import { describe, expect, it } from "vitest"
import { api } from "../__fixtures__/api.ts"

describe("the styles route", () => {
	it("answers the range and ids it parsed from a deepObject and a pipe-delimited value", async () => {
		const { call } = await api()
		const answer = await call("GET", "/v1/styles?range[min]=1&range[max]=5&ids=a|b", { token: null })
		expect(answer).toMatchObject({ body: { ids: ["a", "b"], range: { max: 5, min: 1 } }, status: 200 })
		const encoded = await call("GET", "/v1/styles?range%5Bmin%5D=1&range%5Bmax%5D=5&ids=a%7Cb", { token: null })
		expect(encoded.status).toBe(200)
	})

	it("refuses either value written in another style", async () => {
		const { call } = await api()
		for (const query of [
			"min=1&max=5&ids=a|b",
			"range=min,1,max,5&ids=a|b",
			"range[min]=x&range[max]=5&ids=a|b",
			"range[min]=1&range[max]=5&ids=a,b",
			"range[min]=1&range[max]=5&ids=a&ids=b",
			"range[min]=1&range[max]=5",
		]) {
			const answer = await call("GET", `/v1/styles?${query}`, { token: null })
			expect([query, answer.status, answer.body.error_key]).toEqual([query, 400, "invalid_input"])
		}
	})

	it("is no route for another method", async () => {
		expect((await (await api()).call("POST", "/v1/styles", { body: {} })).status).toBe(404)
	})
})
