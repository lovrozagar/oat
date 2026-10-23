import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { judgeSkipped } from "../../src/cli/commands/conformance-tail.ts"
import { bufferWriter } from "../../src/cli/writer.ts"
import { NODE_FLOOR } from "../../src/errors/node-floor.ts"

/*
 * oat runs as shipped: plain `node`, no flag. The floor is the first Node where `node:sqlite`, a
 * `.ts` config and the QUERY method all work that way, and every place that names it says the same.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), "utf8")
const manifest = JSON.parse(read("package.json")) as { engines: { node: string }; scripts: Record<string, string> }
const FLAGS = /--experimental-(sqlite|strip-types)\b/

describe("the Node floor", () => {
	it("engines.node is >=22.18.0 and no script passes --experimental-sqlite", () => {
		expect(manifest.engines.node).toBe(">=22.18.0")
		expect(Object.entries(manifest.scripts).filter(([, command]) => FLAGS.test(command))).toEqual([])
		const workflows = readdirSync(join(ROOT, ".github", "workflows")).filter((name) => /\.ya?ml$/.test(name))
		expect(workflows.length).toBeGreaterThan(0)
		expect(workflows.filter((name) => FLAGS.test(read(".github", "workflows", name)))).toEqual([])
		expect(FLAGS.test(read("scripts", "conformance-sharded.ts"))).toBe(false)
	})

	it("is the one version that engines, the README and the conformance advice name", () => {
		expect(manifest.engines.node).toBe(`>=${NODE_FLOOR}.0`)
		expect(read("README.md")).toMatch(
			new RegExp(`^Requires \\*\\*Node\\.js ${NODE_FLOOR.replace(".", "\\.")} or later\\*\\*`, "m"),
		)
		const writer = bufferWriter()
		judgeSkipped(writer, {}, ["sqlite"])
		expect(writer.text()).toContain(`oat needs ${NODE_FLOOR} or later`)
	})

	it("is proved in CI on exactly that version: unit and sqlite conformance, on a job pinned to it", () => {
		const jobs = read(".github", "workflows", "ci.yml").split(/^ {2}(?=[a-z-]+:$)/m)
		const pinned = jobs.filter((job) => job.includes(`node-version: "${NODE_FLOOR}.0"`))
		expect(pinned).toHaveLength(1)
		expect(pinned[0]).toContain("bun run test:unit")
		expect(pinned[0]).toContain("node dist/cli.js conformance --backend sqlite --legs passes")
	})
})
