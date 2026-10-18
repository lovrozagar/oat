import { CHECKS } from "../../runtime/checks/registry.ts"
import { EXPECTED_INCONCLUSIVE } from "../expected-failures.ts"
import type { CaseResult } from "./cases.ts"
import type { Backend } from "./engines.ts"

/**
 * How many checks must actually run against each shape.
 *
 * The recurring bug in this tool has been a check that cannot *express* a request looking exactly
 * like a backend that ignores one: gating on a `page` parameter against an offset-paged API, or on
 * a `filter` parameter against one that filters per field. Every instance was found by adding a
 * new dialect and noticing the number drop — which only works if someone is looking.
 *
 * These floors make it automatic. They are deliberately set at the current coverage, so any change
 * that quietly stops a check from applying fails the suite and names it, rather than waiting for a
 * sixth dialect to expose the same class again. Raising a floor when coverage genuinely improves
 * is the intended maintenance; lowering one needs a reason stated in the commit.
 */
const ALL_CHECK_IDS = CHECKS.map((check) => check.id)

export const COVERAGE_FLOOR: Record<string, number> = {
	classic: 80,
	jsonapi: 87,
	linked: 89,
	plain: 71,
	postgrest: 90,
}

/** A leg's answer, from its results in order: the two baselines first, then its defects. */
export function passAnswer(
	results: CaseResult[],
	backend: Backend,
	dialect: string,
): {
	text: string
	failures: number
	proven: string[]
	baselines: { tagged: string[]; untagged: string[] }
	primaryOps: Record<string, string[]>
} {
	const rendered = renderSuite(results, dialect, backend)
	const primaryOps: Record<string, string[]> = {}
	/* Every operation the primary check judged, not the first finding's alone: a defect seen on two
	 * entities is reported twice in no fixed order, and a targeted run must cover the one it shows on. */
	for (const result of results) {
		const operations = result.findings
			.filter((item) => item.check === result.expected)
			.flatMap((item) => item.operations ?? [])
		if (result.defect !== null && operations.length > 0) primaryOps[result.defect] = [...new Set(operations)]
	}
	return {
		baselines: { tagged: results[0]?.checksRun ?? [], untagged: results[1]?.checksRun ?? [] },
		failures: rendered.failures,
		primaryOps,
		proven: [...rendered.proven],
		text: rendered.text,
	}
}

export function renderSuite(
	results: CaseResult[],
	dialect = "postgrest",
	backend: Backend = "memory",
): { text: string; failures: number; proven: Set<string> } {
	const lines: string[] = []
	let failures = 0

	lines.push("")
	lines.push("  defect                     detected  spurious  expected check")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")

	/*
	 * A baseline that reports nothing because it ran nothing is not evidence of precision — and a
	 * baseline that runs *fewer checks than this shape is known to support* is a coverage
	 * regression wearing a clean result's clothes.
	 */
	const floor = COVERAGE_FLOOR[dialect] ?? 10

	for (const result of results) {
		const isBaseline = result.defect === null
		/* Only the *tagged* baseline is held to the floor. The untagged case deliberately strips
		 * every x-* tag to prove oat degrades gracefully without them, so running fewer checks
		 * there is the result being measured, not a regression. */
		const vacuous = result.label === "baseline (correct backend)" && result.checksRun.length < floor
		const leaked = result.leaked ?? 0
		/* A clean baseline that could not decide a check has not shown that check passes. Only a
		 * verdict declared expected for this backend and shape may stand. */
		const variant = result.label === "baseline (untagged spec)" ? ":untagged" : ""
		const allowed = EXPECTED_INCONCLUSIVE[`${backend}:${dialect}${variant}`] ?? []
		const undecided = (result.inconclusive ?? []).filter(
			(entry) => !allowed.some((prefix) => entry.startsWith(`${prefix}:`)),
		)
		const bystanders = result.bystanders ?? []
		const strayLedger = result.strayLedger ?? []
		const missingValues = result.missingValues ?? []
		const unreported = result.unreported ?? []
		const ok =
			bystanders.length === 0 &&
			strayLedger.length === 0 &&
			missingValues.length === 0 &&
			unreported.length === 0 &&
			(isBaseline
				? result.spurious.length === 0 &&
					!vacuous &&
					leaked === 0 &&
					undecided.length === 0 &&
					/* An untagged run that finds nothing *and* runs almost nothing proves nothing. */
					result.checksRun.length >= 10
				: result.detected && result.spurious.length === 0)
		if (!ok) failures++

		const mark = ok ? "✓" : "✗"
		const detected = isBaseline
			? vacuous
				? "VACUOUS"
				: result.spurious.length === 0
					? "clean"
					: "noisy"
			: result.detected
				? "yes"
				: "NO"
		const coverage = isBaseline ? `${result.checksRun.length} checks` : (result.expected ?? "—")
		lines.push(
			`  ${mark} ${result.label.padEnd(26)} ${detected.padEnd(8)} ${String(result.spurious.length).padEnd(9)} ${coverage}`,
		)

		if (bystanders.length > 0) {
			lines.push(`      touched ${bystanders.length} record(s) it did not create: ${bystanders.slice(0, 4).join("; ")}`)
		}
		if (strayLedger.length > 0) {
			lines.push(
				`      ledgered ${strayLedger.length} id(s) the server never created: ${strayLedger.slice(0, 4).join("; ")}`,
			)
		}
		if (missingValues.length > 0) {
			lines.push(`      would have sent a value it did not have: ${missingValues.slice(0, 4).join("; ")}`)
		}
		if (unreported.length > 0) {
			lines.push(
				`      left ${unreported.length} record(s) behind without reporting them: ${unreported.slice(0, 4).join("; ")}`,
			)
		}
		if (leaked > 0) {
			lines.push(`      left ${leaked} record(s) behind after teardown — a run must not litter the system under test`)
		}
		for (const entry of isBaseline ? undecided : []) {
			lines.push(`      inconclusive on a correct backend: ${entry}`)
		}
		if (vacuous) {
			lines.push(
				`      only ${result.checksRun.length} check(s) ran, below the ${floor} this shape ` +
					"supports — a check that stopped applying reads exactly like a clean result",
			)
			const missing = ALL_CHECK_IDS.filter((id) => !result.checksRun.includes(id))
			if (missing.length > 0) lines.push(`      did not run: ${missing.join(", ")}`)
		}
		if (result.error !== undefined) lines.push(`      error: ${result.error}`)
		for (const finding of result.spurious.slice(0, 4)) {
			lines.push(`      spurious: [${finding.check}] ${finding.summary}`)
		}
		if (!isBaseline && !result.detected && result.error === undefined) {
			const others = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP")
			lines.push(`      missed — reported instead: ${others.map((f) => f.check).join(", ") || "nothing"}`)
		}
	}

	const cases = results.length
	const detectionCases = results.filter((r) => r.defect !== null)
	const detected = detectionCases.filter((r) => r.detected).length
	const baseline = results.find((r) => r.defect === null)

	lines.push("")
	lines.push(`  recall     ${detected}/${detectionCases.length} injected defects detected`)
	lines.push(
		`  precision  ${baseline?.spurious.length === 0 ? "clean baseline — no findings against a correct backend" : `${baseline?.spurious.length ?? 0} false positive(s) on the correct backend`}`,
	)
	lines.push(`  ${cases - failures}/${cases} cases passed`)
	lines.push("")

	/* A check is proven by having fired against a defect built for it — not by appearing on a
	 * list of checks a defect may trip. Whether every registered check is proven is decided over
	 * the whole run, since some defects only exist in some shapes. */
	const proven = new Set(
		results
			.filter((r) => r.defect !== null && r.detected)
			.flatMap((r) => r.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check)),
	)

	return { failures, proven, text: lines.join("\n") }
}

/** Registered checks no injected defect made fire anywhere in the run. Each one fails the suite. */
export function renderUnproven(proven: ReadonlySet<string>): { text: string; failures: number } {
	const unproven = ALL_CHECK_IDS.filter((id) => !proven.has(id))
	if (unproven.length === 0) {
		return {
			failures: 0,
			text: `\n  every one of ${ALL_CHECK_IDS.length} registered checks fired on a defect built for it\n`,
		}
	}
	const lines = ["", `  ✗ ${unproven.length} registered check(s) never fired on an injected defect:`]
	for (const id of unproven) lines.push(`      ${id}`)
	lines.push("    a check never shown to detect anything proves nothing by passing — give it a defect or delete it")
	lines.push("")
	return { failures: unproven.length, text: lines.join("\n") }
}
