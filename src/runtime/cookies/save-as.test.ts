import { describe, expect, it } from "vitest"
import { headerValue } from "../headers.ts"
import { answerBody, describeAnswerType, describeSaveAs, readSaveAs, type SaveAsSource } from "./save-as.ts"

function jsonPath(body: unknown, path: string): unknown {
	let node: unknown = body
	for (const segment of path
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return node
}

const source: SaveAsSource = {
	body: { access_token: "from-json" },
	cookies: { session: "from-jar" },
	headers: { "set-cookie": "refresh=from-set", "x-request-id": "rid" },
	readJson: jsonPath,
}

describe("describeSaveAs", () => {
	it("addresses cookies, headers, and JSON paths", () => {
		expect(describeSaveAs("cookie:session")).toEqual({ kind: "cookie", name: "session" })
		expect(describeSaveAs("COOKIE: session")).toEqual({ kind: "cookie", name: "session" })
		expect(describeSaveAs("cookie:")).toEqual({ kind: "cookie", name: "" })
		expect(describeSaveAs("header:x-request-id")).toEqual({ kind: "header", name: "x-request-id" })
		expect(describeSaveAs("Header: X-Foo")).toEqual({ kind: "header", name: "X-Foo" })
		expect(describeSaveAs("$.access_token")).toEqual({ kind: "json", path: "$.access_token" })
		expect(describeSaveAs("plain")).toEqual({ kind: "json", path: "plain" })
	})
})

describe("readSaveAs", () => {
	it("reads a cookie from the jar or the response's Set-Cookie", () => {
		expect(readSaveAs("cookie:session", source)).toBe("from-jar")
		expect(readSaveAs("cookie:refresh", source)).toBe("from-set")
		expect(readSaveAs("cookie:", source)).toBeUndefined()
		expect(readSaveAs("cookie:missing", source)).toBeUndefined()
	})

	it("reads a header by any case, never Set-Cookie, never an empty one", () => {
		expect(headerValue({ "X-Foo": "bar" }, "x-foo")).toBe("bar")
		expect(headerValue({ a: "1" }, "b")).toBeUndefined()
		expect(readSaveAs("header:x-request-id", source)).toBe("rid")
		expect(readSaveAs("header:X-Request-Id", source)).toBe("rid")
		expect(readSaveAs("header:set-cookie", source)).toBeUndefined()
		expect(readSaveAs("header:", source)).toBeUndefined()
		expect(readSaveAs("header:missing", source)).toBeUndefined()
		expect(readSaveAs("header:empty", { ...source, headers: { empty: "" } })).toBeUndefined()
	})

	it("reads anything else as a JSON path of the body", () => {
		expect(readSaveAs("$.access_token", source)).toBe("from-json")
	})
})

const FORM = "access_token=a%2Fb&refresh_token=r+1&expires_in=3600"

/* The form text above, answered under `type`. */
const typed = (type: string) => answerBody({ body: FORM, headers: { "Content-Type": type } })

describe("answerBody", () => {
	it("reads a form answer's fields by name, whatever parameters its media type carries", () => {
		const fields = { access_token: "a/b", expires_in: "3600", refresh_token: "r 1" }
		expect(typed("application/x-www-form-urlencoded")).toEqual(fields)
		expect(typed("Application/X-WWW-Form-Urlencoded; charset=utf-8")).toEqual(fields)
	})

	it("reads a form answer with no text, an empty or a JSON-looking one, as no fields", () => {
		const form = { "content-type": "application/x-www-form-urlencoded" }
		expect(answerBody({ body: null, headers: form })).toEqual({})
		expect(answerBody({ body: 3600, headers: form })).toEqual({})
	})

	it("keeps any other answer's body as it was parsed: JSON by default, and no sniffing", () => {
		expect(answerBody({ body: { a: 1 }, headers: { "content-type": "application/json" } })).toEqual({ a: 1 })
		expect(answerBody({ body: FORM, headers: { "content-type": "text/plain" } })).toBe(FORM)
		expect(answerBody({ body: FORM, headers: {} })).toBe(FORM)
	})
})

describe("describeAnswerType", () => {
	it("names an answer's media type without its parameters, or says it names none", () => {
		expect(describeAnswerType({ "Content-Type": "text/plain; charset=utf-8" })).toBe("its answer is text/plain")
		expect(describeAnswerType({})).toBe("its answer names no content type")
		expect(describeAnswerType({ "content-type": " " })).toBe("its answer names no content type")
	})
})
