import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { expected, holds, shownValue, type Want, wantsOf } from "./want.ts"

const scope = { name: "Ada", n: "2" }

describe("expected", () => {
	it("fills `{name}` in the path and the value, for each mode", () => {
		expect(expected({ equals: "{name}", from: "$.items[?(@.id=='{n}')].text" }, scope)).toEqual({
			from: "$.items[?(@.id=='2')].text",
			mode: "equals",
			value: "Ada",
		})
		expect(expected({ contains: "{name}", from: "$.a" }, scope)).toMatchObject({ mode: "contains", value: "Ada" })
		expect(expected({ excludes: "{name}", from: "$.a" }, scope)).toMatchObject({ mode: "excludes", value: "Ada" })
		expect(expected({ atLeast: 3, from: "$.a" }, scope)).toMatchObject({ mode: "atLeast", value: "3" })
		expect(expected({ from: "$.a", omits: "{name}" }, scope)).toMatchObject({ mode: "omits", value: "Ada" })
	})

	it("refuses an assert that wants nothing", () => {
		expect(() => expected({ from: "$.a" }, scope)).toThrow(
			"oat: an assert on $.a needs equals, contains, excludes, omits or atLeast",
		)
	})
})

/* What an assert wants, spelled out. */
const want = (mode: Want["mode"], from: string, value: string): Want => ({ from, mode, value })

describe("shownValue / holds", () => {
	const answer = exchange("GET", "/notes", {
		body: { items: [{ text: "Ada" }, { text: "Bob" }], meta: { secret: "s" }, total: 4 },
		headers: { "set-cookie": "session=abc", "x-total": "4" },
		status: 200,
	})

	it("reads a JSON path, a header or a cookie", () => {
		expect(shownValue(answer, "$.items[*].text", want("equals", "", "Bob"))).toBe("Bob")
		expect(shownValue(answer, "header:X-Total", want("equals", "", "4"))).toBe("4")
		expect(shownValue(answer, "cookie:session", want("contains", "", "ab"))).toBe("ab")
		expect(shownValue(answer, "cookie:missing", want("equals", "", "x"))).toBeUndefined()
		const parsed = { ...answer, cookies: { session: "xyz" } }
		expect(shownValue(parsed, "cookie:session", want("equals", "", "xyz"))).toBe("xyz")
	})

	it("holds an exclusion and an omission when nothing matches", () => {
		expect(shownValue(answer, "$.items[*].text", want("excludes", "", "Cy"))).toBe("Cy")
		expect(shownValue(answer, "$.items[*].text", want("excludes", "", "Ada"))).toBeUndefined()
		expect(shownValue(answer, "$.meta", want("omits", "", '"secret":'))).toBeUndefined()
		expect(shownValue(answer, "$.meta", want("omits", "", "token"))).toBe("token")
	})

	it("shows the first number at least the floor", () => {
		expect(shownValue(answer, "$.total", want("atLeast", "", "3"))).toBe("4")
		expect(shownValue(answer, "$.total", want("atLeast", "", "5"))).toBeUndefined()
		expect(shownValue(answer, "$.items[*].text", want("atLeast", "", "0"))).toBeUndefined()
		expect(holds(answer, "$.total", want("atLeast", "", "4"))).toBe(true)
		expect(holds(answer, "$.missing", want("contains", "", "x"))).toBe(false)
	})
})

describe("wantsOf", () => {
	it("reads none, one or a list of asserts", () => {
		expect(wantsOf({ operationId: "a" }, scope)).toEqual([])
		expect(wantsOf({ assert: { equals: "1", from: "$.a" }, operationId: "a" }, scope)).toHaveLength(1)
		expect(
			wantsOf(
				{
					assert: [
						{ equals: "1", from: "$.a" },
						{ atLeast: 1, from: "$.b" },
					],
					operationId: "a",
				},
				scope,
			),
		).toHaveLength(2)
	})
})
