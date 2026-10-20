import type { Hooks } from "../../config/types/hooks.ts"
import type { Scenario } from "../../config/types/steps.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { OriginClient, StepContext } from "../steps/request.ts"
import type { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector } from "../finding.ts"
import type { BackoffConfig } from "../poll.ts"
import type { GradeLedger, PassEvidence } from "../grades.ts"

/** A configured principal as a scenario sends as it, `as: { principal: id }`: the parameters bound for it. */
export interface ScenarioPrincipal {
	scope: Readonly<Record<string, string>>
}

export interface ScenarioInput {
	/** True once the run must stop: no further scenario, step or poll starts. */
	stopped?: () => boolean
	scenarios: readonly Scenario[]
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	hooks: Hooks
	checksRun: Set<string>
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	principals: ReadonlyMap<string, ScenarioPrincipal>
	defaultPrincipal: string
	outOfBand?: Partial<BackoffConfig>
	originClients?: ReadonlyMap<string, OriginClient>
	sleep?: (ms: number) => Promise<void>
}

/** One scenario as it runs: where it sends from, and what its steps have bound, sent and shown. */
export interface ScenarioRun {
	input: ScenarioInput
	scenario: Scenario
	sleep: (ms: number) => Promise<void>
	/** The principal the scenario acts as: a step sends `as` it unless it names another, or none. */
	principal: string
	context: StepContext
	/** `{name}` values, the parameters bound for the principal among them from the first step. */
	scope: Record<string, string>
	/**
	 * Values a response or a hook handed back, kept whole: a field that is exactly `{name}` sends
	 * the object itself (a WebAuthn credential), or the number or boolean with its type, not its
	 * string form.
	 */
	objects: Map<string, unknown>
	/** The exchange that called each operation, the one its grade cites. */
	calls: Map<string, Exchange>
	/** What this scenario sent, so a value delivered outside HTTP finds the request it answers. */
	sent: Exchange[]
	observations: Map<string, PassEvidence["observation"]>
}
