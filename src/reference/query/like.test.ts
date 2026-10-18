import { describe, expect, it } from "vitest"
import { likePattern, likeToRegExp } from "./like.ts"

describe("likePattern", () => {
	it("reads * as the wildcard and % and _ as literals", () => {
		expect(likePattern("*a%b_c*", false)).toEqual([{ kind: "any" }, { kind: "text", text: "a%b_c" }, { kind: "any" }])
		expect(likePattern("", false)).toEqual([])
	})

	it("reads % and _ as wildcards when the value is interpolated unescaped", () => {
		expect(likePattern("a%b_", true)).toEqual([
			{ kind: "text", text: "a" },
			{ kind: "any" },
			{ kind: "text", text: "b" },
			{ kind: "one" },
		])
	})
})

describe("likeToRegExp", () => {
	it("anchors the pattern, matching any run, one character, or the text literally", () => {
		const pattern = likeToRegExp([{ kind: "text", text: "a.b" }, { kind: "one" }, { kind: "any" }], false)
		expect(pattern.test("a.bX\nyz")).toBe(true)
		expect(pattern.test("aXbX")).toBe(false)
		expect(pattern.test("A.bX")).toBe(false)
		expect(pattern.flags).toBe("u")
	})

	it("ignores case only when asked", () => {
		const pattern = likeToRegExp([{ kind: "text", text: "$^(x)|[y]{z}+?\\" }], true)
		expect(pattern.flags).toBe("iu")
		expect(pattern.test("$^(X)|[Y]{Z}+?\\")).toBe(true)
	})
})
