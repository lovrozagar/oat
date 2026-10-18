import type { Client } from "../../client/client.ts"
import type { BaselineEntry } from "../../runtime/baseline.ts"
import type { FencedRequest } from "../../runtime/fence.ts"
import type { Finding } from "../../runtime/finding.ts"
import type { CheckTiming } from "../../runtime/run/index.ts"
import type { ScopeReport } from "../../runtime/scope.ts"
import type { TargetVersion } from "../../runtime/target-version.ts"
import type { TeardownReport } from "../../runtime/teardown.ts"
import type { SpecModel } from "../../spec/graph/types.ts"

/** A finished run as every report renderer reads it. */
export interface ReportInput {
	findings: Finding[]
	/** What the unwind removed and left, record by record. Absent when nothing was torn down. */
	teardown?: TeardownReport | null
	model: SpecModel
	client: Client
	baseUrl: string
	entitiesTested: string[]
	checksRun: string[]
	checksSkipped?: Array<{ check: string; entity: string; needs: string }>
	/** Checks not run because a check they depend on was already reported broken. */
	checksSuppressed?: Array<{ check: string; entity: string; because: string }>
	/** Checks a targeted run did not run on an entity because none of their subjects is a target. */
	checksOutOfScope?: Array<{ check: string; entity: string }>
	/** What the run graded, per operation. */
	scope?: ScopeReport
	/** Checks that ran but could not reach a verdict, with the reason they stopped. */
	inconclusive?: Array<{ check: string; entity: string; reason: string }>
	/** Active profile's name — `"full"` unless `--profile` / `config.profile` said otherwise. */
	profile?: string
	/** Operations a profile excluded, and why. Silently narrowing coverage is the failure to avoid. */
	profileExclusions?: Array<{ entity: string; operationId: string; reason: string }>
	startedAt: Date
	durationMs: number
	/** Journal size when exchanges were persisted next to this report. */
	exchanges?: { count: number }
	/** How long each check took on each entity. */
	checkTimings?: CheckTiming[]
	/** What passing checks observed about policies the document leaves open. */
	checkNotes?: Array<{ check: string; entity: string; note: string }>
	network?: {
		kind: string
		attempts: number
		waitedMs: number
		incomplete: boolean
		url: string
	}
	/** Requests `hooks.beforeRequest` refused, and whether that alone fails the run. */
	fenced?: { requests: FencedRequest[]; failRun: boolean }
	/** A signal stopped the run before it finished; what it did test is still reported. */
	interrupted?: boolean
	/** Baseline entries no finding matched any more. Absent with no baseline. */
	baseline?: { fixed: BaselineEntry[] }
	/** The build this run tested, or why it could not be read. */
	targetVersion?: TargetVersion
}
