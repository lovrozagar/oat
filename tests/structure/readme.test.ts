import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * The README is the front page: what oat is, how to start, how auth is declared, what a run's
 * verdicts and exit codes mean, a CI sketch, the limits that matter most, and where every other doc
 * is. It stays about 120 lines; the full limits live in docs/limits.md and the run walkthrough in
 * docs/model.md, so nothing the README drops is lost.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const README = readFileSync(join(ROOT, "README.md"), "utf8")
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), "utf8")

/** A `## heading` section's text, up to the next `## `. */
function section(heading: string): string {
	const start = README.indexOf(`\n## ${heading}\n`)
	if (start === -1) return ""
	const next = README.indexOf("\n## ", start + 1)
	return next === -1 ? README.slice(start) : README.slice(start, next)
}

describe("the README", () => {
	it("stays about 120 lines", () => {
		const lines = README.trimEnd().split("\n").length
		expect(lines).toBeGreaterThanOrEqual(100)
		expect(lines).toBeLessThanOrEqual(135)
	})

	it("starts a user with doctor, then init, then run, on the OpenAPI versions oat reads", () => {
		const start = section("Quick start")
		const at = (command: string) => start.indexOf(`oat ${command}`)
		expect(at("doctor")).toBeGreaterThan(-1)
		expect(at("doctor")).toBeLessThan(at("init"))
		expect(at("init")).toBeLessThan(at("run"))
		expect(README).toMatch(/OpenAPI 3\.0.{0,3}3\.2/)
	})

	it("shows a bearer config and the auth recipe kinds", () => {
		const auth = section("Authentication")
		expect(auth).toContain("security: { bearer: { static:")
		for (const kind of ["login", "mint", "static", "hook", "oauth2"]) expect(auth).toContain(`\`${kind}`)
	})

	it("names every verdict and every exit code from 0 to 4, saying any non-zero fails CI", () => {
		const verdicts = section("Verdicts and exit codes")
		for (const verdict of ["BACKEND_BUG", "SPEC_BUG", "SECURITY", "AMBIGUITY", "COVERAGE_GAP", "BLOCKED"])
			expect(verdicts).toContain(`\`${verdict}\``)
		for (const code of [0, 1, 2, 3, 4]) expect(verdicts).toMatch(new RegExp(`\\| \`${code}\` +\\|`))
		expect(verdicts).toMatch(/any non-zero exit fails/i)
		expect(section("CI")).toContain("oat run --config")
	})

	it("links every top-level doc from its index", () => {
		const docs = readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md"))
		const index = section("Docs")
		expect(docs.filter((name) => !index.includes(`(docs/${name})`))).toEqual([])
	})

	it("keeps what it no longer says: the full limits in docs/limits.md, the run walkthrough in docs/model.md", () => {
		expect(section("Limits")).toContain("(docs/limits.md)")
		expect(read("docs", "limits.md")).toContain("Default request timeout is 180s")
		expect(read("docs", "limits.md")).toContain("No retry on 5xx")
		expect(read("docs", "model.md")).toContain("## How a run works")
		expect(read("docs", "model.md")).toContain("**Teardown** everything the run created")
	})
})
