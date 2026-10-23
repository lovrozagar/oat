import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BACKENDS, LEGS } from "../../src/cli/commands/conformance-matrix.ts"
import { conformanceShards } from "../../src/conformance/shards.ts"

/*
 * CI runs the self-test as shards: nothing drops out of it unnoticed. Every leg and every local
 * backend is in some shard, the matrix is the script's own list, and each shard that needs a server
 * is a job of its own that starts it, runs that shard, and has a timeout of twice its time.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")

const flag = (flags: readonly string[], name: string): string | undefined => {
	const at = flags.indexOf(name)
	return at === -1 ? undefined : flags[at + 1]
}

/** A job of ci.yml, by its id: its lines up to the next job. */
function job(id: string): string {
	const start = CI.indexOf(`\n  ${id}:\n`)
	if (start === -1) return ""
	const next = CI.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
	return next === -1 ? CI.slice(start) : CI.slice(start, start + 1 + next)
}

describe("the conformance shards", () => {
	it("run every leg, and every backend but d1, which is remote and opt-in", () => {
		const shards = conformanceShards()
		const legs = new Set(shards.flatMap((shard) => flag(shard.flags, "--legs")?.split(",") ?? []))
		expect(LEGS.filter((leg) => !legs.has(leg))).toEqual([])
		const backends = new Set(shards.map((shard) => flag(shard.flags, "--backend") ?? "memory"))
		expect(BACKENDS.filter((backend) => backend !== "d1" && !backends.has(backend))).toEqual([])
	})
})

describe("CI's conformance", () => {
	it("is a matrix over the script's own list, judged together by the conformance job", () => {
		expect(job("conformance-plan")).toContain("bun scripts/conformance-sharded.ts --list")
		const shard = job("conformance-shard")
		expect(shard).toContain("fromJSON(needs.conformance-plan.outputs.shards)")
		expect(shard).toContain("timeout-minutes: ${{ matrix.shard.timeout }}")
		expect(shard).toContain('--leg "${{ matrix.shard.name }}"')
		expect(shard).not.toContain("services:")
		expect(job("test")).toMatch(/conformance --aggregate proven/)
	})

	it("judges even when a shard failed or was cancelled, and fails then: a skipped check passes a gate", () => {
		const test = job("test")
		expect(test).toContain("if: ${{ always() }}")
		expect(test).toContain("contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')")
	})

	it("runs each shard that needs a server as a job of its own, starting it, with twice its time", () => {
		for (const shard of conformanceShards().filter((candidate) => candidate.needs !== undefined)) {
			const own = job(`conformance-${shard.needs}`)
			expect(own).toContain(`--leg ${shard.name}`)
			expect(own).toContain(`services:\n      ${shard.needs}:`)
			expect(own).toContain(`timeout-minutes: ${shard.minutes * 2}`)
			expect(job("test")).toContain(`conformance-${shard.needs}`)
		}
	})
})
