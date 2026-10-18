import { DAMAGES_BYSTANDERS, type DefectName } from "../../reference/defects.ts"
import type { Finding, Inconclusive } from "../../runtime/finding.ts"
import { run } from "../../runtime/run/index.ts"
import { EXPECTED } from "../expected/table.ts"
import { damagedBystanders, ledgeredNotCreated, leftBehind, unreportedLeftovers } from "../leaks.ts"
import { checkReproSyntax } from "../suites/repro-syntax.ts"
import { defectsFor } from "./defects.ts"
import type { Backend } from "./engines.ts"
import { acceptableOf, primaryOf } from "./expected.ts"
import { PRINCIPALS } from "./principals.ts"
import { messageOf } from "../../errors/message.ts"

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

async function runAgainst(
	defects: DefectName[],
	untagged = false,
	backend: Backend = "memory",
	dialect = "postgrest",
	shape?: string,
): Promise<{
	findings: Finding[]
	entitiesTested: string[]
	checksRun: string[]
	inconclusive: Inconclusive[]
	leaked: number
	leakedRecords: string[]
	bystanders: string[]
	strayLedger: string[]
	missingValues: string[]
	unreported: string[]
}> {
	/* One HTTP implementation, one store per engine — see reference/http.ts. Imported lazily so
	 * an optional runtime such as node:sqlite cannot take down paths that never touch it. */
	const { createD1Server, createMemoryServer, createPostgresServer, createSqliteServer } =
		await import("../../reference/http.ts")
	const factory =
		backend === "memory"
			? createMemoryServer
			: backend === "sqlite"
				? createSqliteServer
				: backend === "d1"
					? createD1Server
					: createPostgresServer
	const server = await factory({ defects, dialect, untagged, ...(shape === undefined ? {} : { shape }) })
	try {
		const before = await server.snapshot()
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		/* A tester that litters is one nobody runs twice against anything real, so this is
		 * asserted, not assumed — and read from the backend, not from oat's ledger. */
		const after = await server.snapshot()
		const leakedRecords = leftBehind(before, after)
		/* oat changes only what it made, and ledgers only what the backend made for it. */
		const bystanders = damagedBystanders(before, after)
		const strayLedger = ledgeredNotCreated(result.teardown?.records ?? [], server.createdIds())
		/* Whatever the defect let through, a record oat leaves behind is one it must name. */
		const unreported = unreportedLeftovers(leakedRecords, result.teardown)
		/* A request made from a value oat did not have is refused before it leaves; any such check
		 * is a hole in oat, whatever the backend did. */
		const missingValues = result.inconclusive
			.filter((item) => item.reason.startsWith("oat had no value"))
			.map((item) => `${item.check}@${item.entity}`)
		return {
			missingValues,
			checksRun: result.checksRun,
			entitiesTested: result.entitiesTested,
			findings: result.findings,
			inconclusive: result.inconclusive,
			leaked: leakedRecords.length,
			leakedRecords,
			bystanders,
			strayLedger,
			unreported,
		}
	} finally {
		await server.close()
	}
}

export async function runSuite(
	filter?: string[],
	backend: Backend = "memory",
	dialect = "postgrest",
): Promise<CaseResult[]> {
	const results = await runBaselines(backend, dialect)
	for (const defect of defectsFor(backend, dialect, filter)) {
		results.push(await judgeDefect(defect, backend, dialect))
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

/** The two clean baselines of a leg: tagged, then with every meta tag stripped. */
export async function runBaselines(backend: Backend = "memory", dialect = "postgrest"): Promise<CaseResult[]> {
	const results: CaseResult[] = []

	/* Baseline first — everything downstream is meaningless if this is not clean. */
	try {
		const {
			findings,
			entitiesTested,
			checksRun,
			leaked,
			inconclusive,
			bystanders,
			strayLedger,
			missingValues,
			unreported,
		} = await runAgainst([], false, backend, dialect)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			bystanders,
			strayLedger,
			unreported,
			missingValues,
			checksRun,
			inconclusive: inconclusive.map((item) => `${item.check}@${item.entity}: ${item.reason}`),
			leaked,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			acceptable: [],
			label: "baseline (correct backend)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: messageOf(error),
			expected: null,
			findings: [],
			label: "baseline (correct backend)",
			spurious: [],
		})
	}

	/* The same baseline with every meta tag stripped. oat must still be quiet on a correct
	 * backend when it is running on heuristics alone — a fallback that invents findings would
	 * make the tool unusable on any spec that has not been annotated yet. */
	try {
		const { findings, entitiesTested, checksRun, inconclusive, bystanders, strayLedger, missingValues, unreported } =
			await runAgainst([], true, backend, dialect)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			bystanders,
			strayLedger,
			unreported,
			missingValues,
			checksRun,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			inconclusive: inconclusive.map((item) => `${item.check}@${item.entity}: ${item.reason}`),
			acceptable: [],
			label: "baseline (untagged spec)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: messageOf(error),
			expected: null,
			findings: [],
			label: "baseline (untagged spec)",
			spurious: [],
		})
	}

	return results
}

/** One defect, injected alone: detected, and nothing reported that it does not explain. */
export async function judgeDefect(
	defect: DefectName,
	backend: Backend,
	dialect: string,
	shape?: string,
	label: string = defect,
): Promise<CaseResult> {
	const expected = EXPECTED[defect]
	const acceptable = acceptableOf(expected)
	try {
		const { findings, entitiesTested, checksRun, bystanders, strayLedger, missingValues, unreported } =
			await runAgainst([defect], false, backend, dialect, shape)
		/* A defect that by design rewrites other rows is the backend's doing, not oat's. */
		const touched = DAMAGES_BYSTANDERS.has(defect)
			? { bystanders: [], missingValues, strayLedger, unreported }
			: { bystanders, missingValues, strayLedger, unreported }
		const reproFailures = await checkReproSyntax(findings)
		if (reproFailures.length > 0) {
			return {
				acceptable,
				checksRun,
				defect,
				detected: false,
				entitiesTested,
				error: `generated reproducer is not runnable — ${reproFailures[0]}`,
				expected: primaryOf(expected),
				findings,
				label,
				spurious: [],
			}
		}
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		return {
			...touched,
			acceptable,
			checksRun,
			defect,
			detected: real.some((f) => f.check === primaryOf(expected)),
			entitiesTested,
			expected: primaryOf(expected),
			findings,
			label,
			spurious: real.filter((f) => !acceptable.includes(f.check)),
		}
	} catch (error) {
		return {
			acceptable,
			checksRun: [],
			defect,
			detected: false,
			entitiesTested: [],
			error: messageOf(error),
			expected: primaryOf(expected),
			findings: [],
			label,
			spurious: [],
		}
	}
}
