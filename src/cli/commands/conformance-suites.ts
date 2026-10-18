import type { Writer } from "../writer.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

type Cases = Parameters<Toolkit["suite"]["renderParserSuite"]>[0]

/**
 * The suites that need no defect matrix: the document parser, the documented example, the coverage
 * report, tenant scope, feature gates, rate limits, uniqueness, the seed contract, effects and the
 * payload catalog. The tag-unlock claims are judged from the matrix's own runs; only a run that
 * stops before the matrix makes them here. Returns the failures.
 */
export async function runSuites(writer: Writer, toolkit: Toolkit, beforeMatrix: boolean): Promise<number> {
	const { suite } = toolkit
	let failures = 0
	const print = (cases: Cases): void => {
		const rendered = suite.renderParserSuite(cases)
		writer.out(rendered.text)
		failures += rendered.failures
	}
	print(suite.runParserSuite())
	/* The documented example is checked in the same breath: it is the only place a reader sees
	 * where each tag goes, and documentation that drifts teaches a shape that no longer works. */
	print(await suite.runExampleSpecSuite())
	if (beforeMatrix) print(await suite.runTagUnlockSuite())
	print(suite.runCoverageReportSuite())
	print(await suite.runTenantScopeSuite())
	print(await toolkit.featureGate.runFeatureGateSuite())
	print(await toolkit.rateLimit.runRateLimitSuite())
	print(await toolkit.unique.runUniqueSuite())
	print(await toolkit.seedContract.runSeedContractSuite())
	print(await toolkit.effects.runEffectsSuite())
	print(suite.runPayloadCatalogSuite())
	return failures
}
