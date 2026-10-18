import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { answer, guarded, readJson } from "./serve.ts"

function post(body: string) {
	return referenceRequest("post", new URL("http://suite.test/v1/things"), { headers: {}, read: async () => body })
}

describe("answer", () => {
	it("sends a JSON body with its length and type, then any extra headers", () => {
		expect(answer(429, { error_key: "rate_limited" }, { "retry-after": "1" })).toEqual({
			body: '{"error_key":"rate_limited"}',
			headers: { "content-length": "28", "content-type": "application/json", "retry-after": "1" },
			status: 429,
		})
	})

	it("sends a bare status when there is no body", () => {
		expect(answer(204)).toEqual({ body: "", headers: {}, status: 204 })
		expect(answer(503, undefined, { "retry-after": "2" })).toEqual({
			body: "",
			headers: { "retry-after": "2" },
			status: 503,
		})
	})
})

describe("readJson", () => {
	it("parses a body, and reads an empty one as undefined", async () => {
		expect(await readJson(post('{"name":"a"}'))).toEqual({ name: "a" })
		expect(await readJson(post(""))).toBeUndefined()
	})

	it("rejects a malformed body", async () => {
		await expect(readJson(post("{"))).rejects.toThrow(SyntaxError)
	})
})

describe("guarded", () => {
	it("passes an answer through", async () => {
		const handle = guarded(async () => answer(200, { ok: true }))
		expect((await handle(post(""))).status).toBe(200)
	})

	it("answers a bare 500 when the handler throws, or the failure it is given", async () => {
		const broken = async () => answer(200, await readJson(post("{")))
		expect(await guarded(broken)(post(""))).toEqual(answer(500))
		const internal = answer(500, { error_key: "internal" })
		expect(await guarded(broken, internal)(post(""))).toBe(internal)
	})
})
