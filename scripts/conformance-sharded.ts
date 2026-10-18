#!/usr/bin/env bun
/*
 * `bun run conformance:sharded`: the whole self-test as short legs, one process each, so no single
 * step runs for minutes and a machine short of memory never holds the whole matrix at once. Each
 * leg writes the checks its defects proved; the last step judges their union, and fails on a
 * check no leg proved — the same verdict a single full run gives. Prints each leg's time.
 *
 *   bun run conformance:sharded [--jobs n] [--skip-backend sqlite,postgres] [--out dir]
 *
 * Engines that do not answer are left out only when named in --skip-backend, as for a full run.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { SHAPE_NAMES } from "../src/conformance/shapes.ts"
import { postgresAvailable, sqliteAvailable } from "../src/conformance/suite.ts"

const { values } = parseArgs({
	options: { jobs: { type: "string" }, out: { type: "string" }, "skip-backend": { type: "string" } },
})
const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "oat-conformance-")))
const skip = new Set((values["skip-backend"] ?? "").split(",").filter(Boolean))
const jobs = values.jobs === undefined ? [] : ["--jobs", values.jobs]
const cli = resolve(import.meta.dirname, "..", "dist", "cli.js")

/** One leg: its name, and the conformance flags that run it. */
type Leg = [name: string, flags: string[]]

/** Shapes per recall leg: every defect again behind each, about a minute a shape on three workers. */
const SHAPES_PER_LEG = 5

/** The shapes and recall behind them, a few shapes per leg. */
function recallGroups(): Leg[] {
	return Array.from({ length: Math.ceil(SHAPE_NAMES.length / SHAPES_PER_LEG) }, (_, index): Leg => [
		`shapes-recall-${index + 1}`,
		[
			"--legs",
			"shapes,recall",
			"--shapes",
			SHAPE_NAMES.slice(index * SHAPES_PER_LEG, (index + 1) * SHAPES_PER_LEG).join(","),
		],
	])
}

async function legs(): Promise<Leg[] | string> {
	const engines: Leg[] = []
	for (const [backend, available] of [
		["sqlite", await sqliteAvailable()],
		["postgres", await postgresAvailable()],
	] as const) {
		if (available) engines.push([`${backend}-postgrest`, ["--backend", backend, "--legs", "passes"]])
		else if (!skip.has(backend)) return `${backend} is not reachable: start it, or pass --skip-backend ${backend}`
	}
	return [
		["suites", ["--legs", "suites"]],
		["memory-postgrest", ["--backend", "memory", "--dialect", "postgrest", "--legs", "passes,scope"]],
		...engines,
		...["classic", "linked", "jsonapi", "plain", "template"].map((dialect): Leg => [
			`memory-${dialect}`,
			["--backend", "memory", "--dialect", dialect, "--legs", "passes"],
		]),
		...recallGroups(),
		["combinations", ["--legs", "fuzz"]],
	]
}

function conformance(flags: readonly string[]): number {
	return spawnSync("node", ["--experimental-sqlite", cli, "conformance", ...flags], { stdio: "inherit" }).status ?? 1
}

const planned = await legs()
if (typeof planned === "string") {
	console.error(`oat: ${planned}`)
	process.exit(2)
}
const timings: Array<{ name: string; code: number; seconds: number }> = []
for (const [name, flags] of planned) {
	process.stdout.write(`\n══ ${name} ${"═".repeat(60 - name.length)}\n`)
	const began = performance.now()
	const code = conformance([...flags, ...jobs, "--proven-out", join(out, `${name}.json`)])
	timings.push({ code, name, seconds: Math.round((performance.now() - began) / 100) / 10 })
}
process.stdout.write(`\n══ aggregate ${"═".repeat(51)}\n`)
const judged = conformance(["--aggregate", out])
process.stdout.write("\n  leg                 exit   seconds\n")
for (const { name, code, seconds } of timings)
	process.stdout.write(`  ${name.padEnd(20)}${String(code).padEnd(7)}${seconds}\n`)
process.stdout.write(`  ${"aggregate".padEnd(20)}${judged}\n  proven checks: ${out}\n`)
process.exit(timings.some((leg) => leg.code !== 0) || judged !== 0 ? 1 : 0)
