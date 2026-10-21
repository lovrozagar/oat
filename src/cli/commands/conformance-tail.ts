import { type Args, str } from "../flags.ts"
import type { Writer } from "../writer.ts"
import type { BackendName } from "./conformance-matrix.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

/**
 * An engine that is not there is not a pass: the SQL-only defects and every engine difference go
 * untested. Leaving one out has to be asked for by name. Returns the failures.
 */
export function judgeSkipped(writer: Writer, flags: Args["flags"], skipped: readonly BackendName[]): number {
	if (skipped.length === 0) return 0
	const allowed = new Set(str(flags, "skip-backend")?.split(",") ?? [])
	let failures = 0
	for (const backend of skipped) {
		const why =
			backend === "sqlite"
				? "node:sqlite unavailable (Node 22 needs --experimental-sqlite)"
				: "no Postgres server reachable on the default connection"
		if (allowed.has(backend)) {
			writer.out(`  note: ${backend} backend skipped as asked — ${why}\n`)
			continue
		}
		failures += 1
		writer.out(`  ✗ ${backend} backend unavailable — ${why}. Start it, or pass --skip-backend ${backend}\n`)
	}
	writer.out("\n")
	return failures
}

/**
 * A short combination pass, part of the standard self-test. Single-defect recall says nothing
 * about how the diagnosis holds up when several faults overlap, and every bug the fuzzer has found
 * so far — silent bail-outs, non-transitive suppression, a probe writing into a constrained field —
 * was invisible to the one-at-a-time matrix. A fixed seed tests the same 40 combinations forever;
 * CI passes a fresh one per run, and the seed is printed so any failure replays exactly. The flag
 * parser has already refused a seed that is not a positive integer. The pass ends with the requests
 * its combinations sent, by source. Returns the failures.
 */
export async function runCombinations(writer: Writer, flags: Args["flags"], toolkit: Toolkit): Promise<number> {
	writer.out(`\n  ── combinations ${"─".repeat(46)}\n`)
	const seed = Number.parseInt(str(flags, "fuzz-seed") ?? "1", 10)
	writer.out(`  fuzz seed ${seed} — replay with --fuzz 40 --max-defects 6 --seed ${seed}\n`)
	const counted = toolkit.suite.counting(toolkit.suite.listening)
	const smoke = toolkit.fuzz.renderFuzz(
		await toolkit.fuzz.runFuzz({ backend: "memory", cases: 40, maxDefects: 6, seed, via: counted.via }),
	)
	writer.out(`${smoke.text}${toolkit.suite.requestLines(counted.requests())}`)
	return smoke.failures
}

/** Present but never default: D1 is remote, so a pass costs minutes and someone's quota. */
export function noteD1(writer: Writer, toolkit: Toolkit): void {
	writer.out(
		toolkit.suite.d1Available()
			? "  note: d1 backend available — run with --backend d1 (remote, ~2min per defect)\n\n"
			: "  note: d1 backend needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN\n\n",
	)
}
