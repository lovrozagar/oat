import type { Writer } from "../writer.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

type Cases = Parameters<Toolkit["suite"]["renderParserSuite"]>[0]

/**
 * The suites that need no defect matrix: the document parser, the documented example, the coverage
 * report, tenant scope, feature gates, rate limits, uniqueness, the seed contract, effects and the
 * payload catalog. The tag-unlock claims are judged from the matrix's own runs; only a run that
 * stops before the matrix makes them here. Every suite that runs oat reaches its target through one
 * counter, and the leg ends with the requests they sent, by source. Returns the failures.
 */
export async function runSuites(writer: Writer, toolkit: Toolkit, beforeMatrix: boolean): Promise<number> {
	const { suite } = toolkit
	let failures = 0
	const print = (cases: Cases): void => {
		const rendered = suite.renderParserSuite(cases)
		writer.out(rendered.text)
		failures += rendered.failures
	}
	const counted = suite.counting(suite.listening)
	const { via } = counted
	print(suite.runParserSuite())
	/* The documented example is checked in the same breath: it is the only place a reader sees
	 * where each tag goes, and documentation that drifts teaches a shape that no longer works. */
	print(await suite.runExampleSpecSuite())
	if (beforeMatrix) print(await suite.runTagUnlockSuite(via))
	print(suite.runCoverageReportSuite())
	print(await suite.runTenantScopeSuite(via))
	print(await toolkit.featureGate.runFeatureGateSuite(via))
	print(await toolkit.rateLimit.runRateLimitSuite(via))
	print(await toolkit.unique.runUniqueSuite(via))
	print(await toolkit.seedContract.runSeedContractSuite(via))
	print(await toolkit.effects.runEffectsSuite(via))
	print(suite.runPayloadCatalogSuite())
	writer.out(suite.requestLines(counted.requests()))
	return failures
}
