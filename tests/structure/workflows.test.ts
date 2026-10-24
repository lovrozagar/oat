import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { hasHeading } from "../../scripts/changelog-has.ts"

/*
 * CI and the release run the same gates, and a release is refused before it publishes anything
 * when the changelog does not name its version. Every job that runs on a machine has a timeout of
 * its own, so a hung step ends the run instead of holding a runner for six hours.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const workflow = (name: string): string => readFileSync(join(ROOT, ".github", "workflows", name), "utf8")
const WORKFLOWS = ["ci.yml", "release.yml", "targets.yml"] as const

/** The workflow's jobs, by id: each job's lines up to the next. */
function jobs(text: string): Map<string, string> {
	const body = text.slice(text.indexOf("\njobs:\n") + 7)
	const out = new Map<string, string>()
	for (const part of body.split(/\n(?= {2}[a-z][\w-]*:\n)/)) {
		const id = /^ {2}([a-z][\w-]*):/.exec(part)?.[1]
		if (id !== undefined) out.set(id, part)
	}
	return out
}

describe("hasHeading", () => {
	it("finds a `## <version>` line, and nothing short of one", () => {
		const changelog = "# Changelog\n\n## 0.25.0\n\n- a\n\n## 0.24.1\n"
		expect(hasHeading(changelog, "0.25.0")).toBe(true)
		expect(hasHeading(changelog, "0.24.1")).toBe(true)
		expect(hasHeading(changelog, "0.25")).toBe(false)
		expect(hasHeading("## 0.25.0-rc.1\n", "0.25.0")).toBe(false)
		expect(hasHeading("text mentioning 0.25.0\n", "0.25.0")).toBe(false)
	})
})

describe("the changelog", () => {
	it("has a heading for the version package.json names, so that version's tag can be released", () => {
		const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
		expect(hasHeading(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version)).toBe(true)
	})
})

describe("the workflows", () => {
	it("give every job that runs on a machine an explicit timeout", () => {
		for (const name of WORKFLOWS) {
			const untimed = [...jobs(workflow(name))].filter(
				([, job]) => job.includes("runs-on:") && !job.includes("timeout-minutes:"),
			)
			expect(untimed.map(([id]) => `${name}: ${id}`)).toEqual([])
		}
	})

	it("run CI's own gates on a release, through ci.yml called as a reusable workflow", () => {
		expect(workflow("ci.yml")).toMatch(/^on:\n(?: {2}.*\n)*? {2}workflow_call:/m)
		const release = jobs(workflow("release.yml"))
		expect(release.get("gates")).toContain("uses: ./.github/workflows/ci.yml")
		for (const publish of ["npmjs", "gh-pkg"]) {
			expect(release.get(publish)).toMatch(/needs: \[gates, changelog\]/)
		}
	})

	it("refuse a release whose CHANGELOG.md has no heading for its version, before publishing", () => {
		const changelog = jobs(workflow("release.yml")).get("changelog") ?? ""
		expect(changelog).toContain("bun scripts/changelog-has.ts")
		expect(changelog).toContain("timeout-minutes:")
	})

	it("run the packed package end to end in CI, and the real-API targets on demand only", () => {
		expect(jobs(workflow("ci.yml")).get("e2e")).toContain("bun run test:e2e")
		expect(existsSync(join(ROOT, ".github", "workflows", "targets.yml"))).toBe(true)
		const targets = workflow("targets.yml")
		/* No schedule until a dispatched run proves the five stacks fit a runner (crAPI peaked near 16 GB). */
		expect(targets).not.toContain("schedule:")
		expect(targets).toContain("workflow_dispatch:")
		expect(targets).toContain("bun run test:targets")
	})
})
