import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ensureVendored } from "../support/vendored.ts"
import { compose, missing, runTarget, unexpected, type Target, TARGETS_DIR, type TargetRun } from "./target.ts"

/*
 * oat against real APIs: each target's stack up from pinned images, prepared as a fresh install
 * would be, run once with its config. A run must finish (exit 0 or 1, never `failed`) and report
 * exactly the findings in its expected.json: one missing is a lost catch, one extra is a false
 * positive or a defect nobody judged. `OAT_TARGETS=keycloak,vampi` runs some of them.
 */

const asked = process.env["OAT_TARGETS"]?.split(",").filter(Boolean)
const names = readdirSync(TARGETS_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(TARGETS_DIR, entry.name, "target.ts")))
	.map((entry) => entry.name)
	.filter((name) => asked === undefined || asked.includes(name))
	.toSorted()

describe.each(names)("%s", (name) => {
	let run: TargetRun
	let out: string

	beforeAll(async () => {
		const target = ((await import(join(TARGETS_DIR, name, "target.ts"))) as { default: Target }).default
		await ensureVendored(join(TARGETS_DIR, name), target.vendored ?? [])
		compose(name, ["up", "-d", "--wait", "--quiet-pull"])
		out = await mkdtemp(join(tmpdir(), `oat-target-${name}-`))
		run = await runTarget(name, await target.prepare(target.baseUrl), out)
		/* `OAT_TARGETS_SUMMARY=<dir>` keeps each run's console summary, which the run's folder does not outlive. */
		const summary = process.env["OAT_TARGETS_SUMMARY"]
		if (summary !== undefined) {
			await writeFile(join(summary, `${name}.txt`), `exit ${run.code}\n${run.out}`)
			await writeFile(join(summary, `${name}.report.json`), JSON.stringify(run.report, null, 1))
		}
	}, 900_000)

	afterAll(async () => {
		compose(name, ["down", "-v", "--remove-orphans"])
		await rm(out, { force: true, recursive: true })
	}, 300_000)

	it("finishes: exit 0 or 1, never a failed run", () => {
		expect({ code: run.code, outcome: run.report.outcome.result }).not.toMatchObject({ outcome: "failed" })
		expect([0, 1]).toContain(run.code)
	})

	it("reports every finding the target is known to deserve", () => {
		expect(missing(run)).toEqual([])
	})

	it("reports nothing else: every finding is one the target is known to deserve", () => {
		expect(unexpected(run)).toEqual([])
	})
})
