import { describe, expect, it } from "vitest"
import { rule } from "./no-header-branching.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE =
	"credential placement comes from the operation's OpenAPI security (src/spec/security/); do not name an auth header or scheme prefix here"

describe("oat/no-header-branching", () => {
	it("flags an auth header name or a scheme prefix written outside the security modules", () => {
		const fixture = {
			"src/runtime/auth.ts": [
				'export const h = header ?? "authorization"',
				"export const v = `Bearer ${token}`",
				'export const w = "Basic " + encoded',
				'export const t = "Bearer {credential}"',
				'export const x = headers["Authorization"]',
				'export const y = name.toLowerCase() === "x-api-key"',
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6])
		expect(reportsOf(rule, fixture)[0]?.message).toBe(MESSAGE)
	})

	it("allows the security, spec security and credentials modules, the reference server, the self-test and tests", () => {
		const source = 'export const h = "authorization"\nexport const v = `Bearer ${t}`\n'
		const fixture = {
			"src/security/credential-names.ts": source,
			"src/spec/security/placement.ts": source,
			"src/credentials/store.ts": source,
			"src/client/credentials.ts": source,
			"src/reference/http/access.ts": source,
			"src/conformance/suites/tenant-scope.ts": source,
			"src/runtime/auth.test.ts": source,
			"tests/integration/auth.test.ts": source,
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("leaves unrelated strings alone", () => {
		const source =
			'export const a = "content-type"\nexport const b = `Bearer`\nexport const c = "authorized"\nexport const d = tag`\\unicode`\n'
		expect(reportsOf(rule, { "src/runtime/a.ts": source })).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const fixture = { "src/runtime/a.ts": 'export const h = "authorization"\n' }
		expect(oxlintReports("no-header-branching", fixture).length).toBe(1)
	})
})
