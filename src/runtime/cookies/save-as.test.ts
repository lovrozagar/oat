import { describe, expect, it } from "vitest"
import { headerValue } from "../headers.ts"
import { describeSaveAs, readSaveAs, type SaveAsSource } from "./save-as.ts"

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
