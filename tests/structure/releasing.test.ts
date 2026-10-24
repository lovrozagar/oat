import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * docs/releasing.md is how a release is cut, and release.yml is what actually runs: the doc names
 * every job the workflow runs and the exact Trusted Publisher connection it checks, so a change to
 * one that the other does not follow fails here.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), "utf8")
const DOC = read("docs", "releasing.md")
const WORKFLOW = read(".github", "workflows", "release.yml")

describe("docs/releasing.md", () => {
	it("names every job release.yml runs", () => {
		const jobs = [...WORKFLOW.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]?.trim() ?? "")
		expect(jobs.length).toBeGreaterThan(0)
		expect(jobs.filter((job) => !DOC.includes(job))).toEqual([])
	})

	it("gives the Trusted Publisher connection release.yml checks, word for word", () => {
		const connection = /echo "  (GitHub Actions \/ [^"]+)"/.exec(WORKFLOW)?.[1]
		expect(connection).toBeDefined()
		expect(DOC).toContain(connection)
	})

	it("says a release is a tag that matches package.json, published with provenance", () => {
		expect(WORKFLOW).toContain('- "v*"')
		expect(DOC).toContain("`v*`")
		expect(DOC).toMatch(/package\.json/)
		expect(DOC).toContain("--provenance")
	})
})
