import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import type { Member } from "./ast.ts"
import { propertyName } from "./nodes.ts"

const member = (code: string): Member =>
	(parseSync("a.ts", code).program.body[0] as unknown as { expression: Member }).expression

describe("propertyName", () => {
	it("reads a dotted name and a string-keyed computed name", () => {
		expect(propertyName(member("a.name"))).toBe("name")
		expect(propertyName(member('a["name"]'))).toBe("name")
	})

	it("is empty for a computed key that is not a string literal", () => {
		expect(propertyName(member("a[key]"))).toBe("")
		expect(propertyName(member("a[1]"))).toBe("")
	})
})
