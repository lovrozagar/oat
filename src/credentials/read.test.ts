import { describe, expect, it } from "vitest"
import { readAnswer } from "./read.ts"

describe("readAnswer", () => {
	const answer = { body: { token: "b" }, cookies: { sid: "c" }, headers: { "x-token": "h" }, status: 200 }

	it("reads the body, a header or a cookie by the saveAs address forms", () => {
		expect([
			readAnswer(answer, "$.token"),
			readAnswer(answer, "header:X-Token"),
			readAnswer(answer, "cookie:sid"),
		]).toEqual(["b", "h", "c"])
	})

	it("reads a JSON pointer and a filter, as every other `from` in oat does", () => {
		const body = {
			keys: [
				{ kind: "web", value: "w" },
				{ kind: "api", value: "a" },
			],
			token: "t",
		}
		expect([
			readAnswer({ ...answer, body }, "/token"),
			readAnswer({ ...answer, body }, "$.keys[?(@.kind=='api')].value"),
		]).toEqual(["t", "a"])
	})

	it("is a string only when the value is a non-empty string or a number", () => {
		const body = { empty: "", n: 7, object: {} }
		expect([
			readAnswer({ ...answer, body }, "$.n"),
			readAnswer({ ...answer, body }, "$.empty"),
			readAnswer({ ...answer, body }, "$.object"),
			readAnswer(answer, "$.missing"),
		]).toEqual(["7", undefined, undefined, undefined])
	})
})
