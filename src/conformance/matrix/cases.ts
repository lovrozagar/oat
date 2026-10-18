import { messageOf } from "../../errors/message.ts"
import { DAMAGES_BYSTANDERS } from "../../reference/defects/bystanders.ts"
import type { DefectName } from "../../reference/defects/table.ts"
import type { Finding, Inconclusive } from "../../runtime/finding.ts"
import { run } from "../../runtime/run/index.ts"
import { EXPECTED } from "../expected/table.ts"
import { launch, reach, type Target } from "../harness/launch.ts"
import { damagedBystanders, ledgeredNotCreated, leftBehind, unreportedLeftovers } from "../leaks.ts"
import { checkReproSyntax } from "../suites/repro-syntax.ts"
import { defectsFor } from "./defects.ts"
import { acceptableOf, primaryOf } from "./expected.ts"
import { PRINCIPALS } from "./principals.ts"

export interface CaseResult {
	label: string
	defect: DefectName | null
	expected: string | null
	detected: boolean
	/** Findings unrelated to the injected defect — false positives. */
	spurious: Finding[]
	findings: Finding[]
	entitiesTested: string[]
	/** Checks that actually executed. A clean run that ran nothing is not a pass. */
	checksRun: string[]
	/** Records created and not cleaned up. */
	leaked?: number
	/** Records that existed before the run and were deleted or changed by it. */
	bystanders?: string[]
	/** Ids oat ledgered for teardown that the backend never created. */
	strayLedger?: string[]
	/** Records left behind that teardown neither named as failed nor counted as unidentified. */
	unreported?: string[]
	/** Checks that would have sent a value oat did not have (the text "undefined"), as `check@entity`. */
	missingValues?: string[]
	/** Checks that ran and could not reach a verdict, as `check@entity: reason`. */
	inconclusive?: string[]
	/** Checks this defect may legitimately trip, primary first. */
	acceptable?: string[]
	error?: string
}

/** What one run against the reference showed, findings and the backend's own state both. */
interface Observed {
	findings: Finding[]
	entitiesTested: string[]
	checksRun: string[]
	inconclusive: Inconclusive[]
	leaked: number
	bystanders: string[]
	strayLedger: string[]
	missingValues: string[]
	unreported: string[]
}

/**
 * Checks that would have sent a value oat did not have, as `check@entity`. A request made from a
 * value oat did not have is refused before it leaves; any such check is a hole in oat, whatever
 * the backend did.
 */
export function missingValuesOf(inconclusive: readonly Inconclusive[]): string[] {
	return inconclusive
		.filter((item) => item.reason.startsWith("oat had no value"))
		.map((item) => `${item.check}@${item.entity}`)
}

/** oat run once against the reference with `defects` injected, and what it left in the backend. */
async function observe(defects: DefectName[], target: Target, untagged: boolean): Promise<Observed> {
	const server = await launch(target, { defects, untagged })
	try {
		const before = await server.snapshot()
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...reach(server),
		})
		/* A tester that litters is one nobody runs twice against anything real, so this is asserted,
		 * not assumed — and read from the backend, not from oat's ledger. */
		const after = await server.snapshot()
		const leakedRecords = leftBehind(before, after)
		return {
			/* oat changes only what it made, and ledgers only what the backend made for it. */
			bystanders: damagedBystanders(before, after),
			checksRun: result.checksRun,
			entitiesTested: result.entitiesTested,
			findings: result.findings,
			inconclusive: result.inconclusive,
			leaked: leakedRecords.length,
			missingValues: missingValuesOf(result.inconclusive),
			strayLedger: ledgeredNotCreated(result.teardown?.records ?? [], server.createdIds()),
			/* Whatever the defect let through, a record oat leaves behind is one it must name. */
			unreported: unreportedLeftovers(leakedRecords, result.teardown),
		}
	} finally {
		await server.close()
	}
}

export async function runSuite(target: Target, filter?: string[]): Promise<CaseResult[]> {
	const results = await runBaselines(target)
	for (const defect of defectsFor(target.backend, target.dialect, filter)) {
		results.push(await judgeDefect(defect, target))
	}
	return results
}

/** A finding without the exchanges it cites. */
function strip(finding: Finding): Finding {
	return { ...finding, evidence: [] }
}

/**
 * A case's result as it can cross to another thread: findings keep everything the verdicts read,
 * and drop the exchanges they cite, which hold live bodies.
 */
export function portableResult(result: CaseResult): CaseResult {
	return { ...result, findings: result.findings.map(strip), spurious: result.spurious.map(strip) }
}

/**
 * The two clean baselines of a leg: tagged, then with every meta tag stripped. The tagged one comes
 * first — everything downstream is meaningless if it is not clean. oat must stay quiet without the
 * tags too, running on heuristics alone: a fallback that invents findings would make the tool
 * unusable on any spec that has not been annotated yet.
 */
export async function runBaselines(target: Target): Promise<CaseResult[]> {
	return [await baseline(target, false), await baseline(target, true)]
}

async function baseline(target: Target, untagged: boolean): Promise<CaseResult> {
	const label = untagged ? "baseline (untagged spec)" : "baseline (correct backend)"
	const empty = { defect: null, expected: null, label }
	try {
		const { leaked, inconclusive, findings, ...observed } = await observe([], target, untagged)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		return {
			...empty,
			...observed,
			acceptable: [],
			detected: real.length === 0,
			findings,
			inconclusive: inconclusive.map((item) => `${item.check}@${item.entity}: ${item.reason}`),
			/* The untagged run strips the very tags teardown leans on; only the tagged one is held to it. */
			...(untagged ? {} : { leaked }),
			spurious: real,
		}
	} catch (error) {
		return {
			...empty,
			checksRun: [],
			detected: false,
			entitiesTested: [],
			error: messageOf(error),
			findings: [],
			spurious: [],
		}
	}
}

/** What a defect case is judged by beyond its run; the defaults are the suite's own. */
export interface Judging {
	/** Defects that damage bystanders by design. */
	excused?: ReadonlySet<DefectName>
	/** Each generated reproducer's problems; none when every one is runnable. */
	checkRepros?: (findings: Finding[]) => Promise<string[]>
}

/** One defect, injected alone: detected, and nothing reported that it does not explain. */
export async function judgeDefect(
	defect: DefectName,
	target: Target,
	label: string = defect,
	{ checkRepros = checkReproSyntax, excused = DAMAGES_BYSTANDERS }: Judging = {},
): Promise<CaseResult> {
	const expected = EXPECTED[defect]
	const acceptable = acceptableOf(expected)
	const verdict = { acceptable, defect, expected: primaryOf(expected), label }
	try {
		const { findings, entitiesTested, checksRun, bystanders, strayLedger, missingValues, unreported } = await observe(
			[defect],
			target,
			false,
		)
		const reproFailures = await checkRepros(findings)
		if (reproFailures.length > 0) {
			const error = `generated reproducer is not runnable — ${reproFailures[0]}`
			return { ...verdict, checksRun, detected: false, entitiesTested, error, findings, spurious: [] }
		}
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		return {
			...verdict,
			/* A defect that by design rewrites other rows is the backend's doing, not oat's. */
			bystanders: excused.has(defect) ? [] : bystanders,
			checksRun,
			detected: real.some((f) => f.check === verdict.expected),
			entitiesTested,
			findings,
			missingValues,
			spurious: real.filter((f) => !acceptable.includes(f.check)),
			strayLedger,
			unreported,
		}
	} catch (error) {
		return {
			...verdict,
			checksRun: [],
			detected: false,
			entitiesTested: [],
			error: messageOf(error),
			findings: [],
			spurious: [],
		}
	}
}
