#!/usr/bin/env bun
/*
 * `bun run conformance:sharded`: the whole self-test as short legs, one process each, so no single
 * step runs for minutes and a machine short of memory never holds the whole matrix at once. Each
 * leg writes the checks its defects proved; the last step judges their union, and fails on a
 * check no leg proved — the same verdict a single full run gives. Prints each leg's time.
 *
 *   bun run conformance:sharded [--jobs n] [--skip-backend sqlite,postgres] [--out dir]
 *   bun scripts/conformance-sharded.ts --list            the shards as JSON, for a CI matrix
 *   bun scripts/conformance-sharded.ts --leg <name> --out dir [-- flags]   one shard, as a CI job
 *
 * Engines that do not answer are left out only when named in --skip-backend, as for a full run.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { postgresStatus, sqliteAvailable } from "../src/conformance/matrix/engines.ts"
import { conformanceShards, type Shard } from "../src/conformance/shards.ts"

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		jobs: { type: "string" },
		leg: { type: "string" },
		list: { type: "boolean" },
		out: { type: "string" },
		"skip-backend": { type: "string" },
	},
})
const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "oat-conformance-")))
const skip = new Set((values["skip-backend"] ?? "").split(",").filter(Boolean))
const jobs = values.jobs === undefined ? [] : ["--jobs", values.jobs]
const cli = resolve(import.meta.dirname, "..", "dist", "cli.js")

function conformance(flags: readonly string[]): number {
	return spawnSync("node", [cli, "conformance", ...flags], { stdio: "inherit" }).status ?? 1
}

/* One shard, writing the checks it proved where the aggregate reads them. */
function runShard(shard: Shard, extra: readonly string[]): number {
	return conformance([...shard.flags, ...jobs, ...extra, "--proven-out", join(out, `${shard.name}.json`)])
}

/* The shards this machine can run: an engine that does not answer stops the run unless it is skipped. */
async function runnable(): Promise<Shard[] | string> {
	const available = { postgres: (await postgresStatus()) === "ready", sqlite: await sqliteAvailable() }
	const shards: Shard[] = []
	for (const shard of conformanceShards()) {
		const backend = shard.flags[shard.flags.indexOf("--backend") + 1]
		const engine = backend === "sqlite" || backend === "postgres" ? backend : undefined
		if (engine === undefined || available[engine]) shards.push(shard)
		else if (!skip.has(engine)) return `${engine} is not reachable: start it, or pass --skip-backend ${engine}`
	}
	return shards
}

/* The shards CI runs as a matrix: those with nothing to start. One that needs a server is a job of its own. */
if (values.list === true) {
	const matrix = conformanceShards()
		.filter((shard) => shard.needs === undefined)
		.map(({ name, minutes }) => ({ name, timeout: minutes * 2 }))
	process.stdout.write(`${JSON.stringify(matrix)}\n`)
	process.exit(0)
}

if (values.leg !== undefined) {
	const shard = conformanceShards().find((candidate) => candidate.name === values.leg)
	if (shard === undefined) {
		console.error(`oat: no conformance shard named ${values.leg}`)
		process.exit(2)
	}
	process.exit(runShard(shard, positionals))
}

const planned = await runnable()
if (typeof planned === "string") {
	console.error(`oat: ${planned}`)
	process.exit(2)
}
const timings: Array<{ name: string; code: number; seconds: number }> = []
for (const shard of planned) {
	process.stdout.write(`\n══ ${shard.name} ${"═".repeat(60 - shard.name.length)}\n`)
	const began = performance.now()
	const code = runShard(shard, [])
	timings.push({ code, name: shard.name, seconds: Math.round((performance.now() - began) / 100) / 10 })
}
process.stdout.write(`\n══ aggregate ${"═".repeat(51)}\n`)
const judged = conformance(["--aggregate", out])
process.stdout.write("\n  leg                 exit   seconds\n")
for (const { name, code, seconds } of timings)
	process.stdout.write(`  ${name.padEnd(20)}${String(code).padEnd(7)}${seconds}\n`)
process.stdout.write(`  ${"aggregate".padEnd(20)}${judged}\n  proven checks: ${out}\n`)
process.exit(timings.some((leg) => leg.code !== 0) || judged !== 0 ? 1 : 0)
