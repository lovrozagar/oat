import type { Hooks } from "../../config/types/hooks.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { PrincipalRuntime } from "../auth.ts"
import type { Exchange } from "../exchange.ts"
import type { ProvenId } from "../proven-id.ts"
import type { Scenario } from "../../config/types/steps.ts"
import type { OriginClient } from "../auth.ts"
import type { Client } from "../../client/client.ts"
import type { ExchangeJournal } from "../exchanges.ts"
import type { Fence } from "../fence.ts"
import type { FindingCollector } from "../finding.ts"
import type { BackoffConfig } from "../poll.ts"
import type { ResolvedProfile } from "../profile.ts"
import type { GradeLedger, TargetScope } from "../scope.ts"
import type { TargetVersion } from "../target-version.ts"
import type { Ledger, Owner } from "../teardown.ts"
import type { UploadContext } from "../upload.ts"
import type { SchemaValidator } from "../validate.ts"
import type { RunCredentials } from "./credentials.ts"
import type { RunNetwork } from "./network.ts"
import type { RunProgress } from "./progress.ts"
import type { RunState } from "./state.ts"
import type { RunOptions } from "./types.ts"

/*
 * The run's context, built stage by stage: each stage takes what the stages before it made and
 * adds its own part. A stage's input type names exactly what it may use.
 */

/** The document read and modelled; nothing sent to the API yet. */
export interface Loaded {
	options: RunOptions
	hooks: Hooks
	findings: FindingCollector
	profile: ResolvedProfile
	progress: RunProgress
	fence: Fence | undefined
	model: SpecModel
	state: RunState
}

/** A client to talk to the API with, and what records the run's exchanges and fixtures. */
export interface Connected extends Loaded {
	client: Client
	/** The run's principals as the client sees them: bound as each logs in. */
	credentials: RunCredentials
	journal: ExchangeJournal | null
	network: RunNetwork
	originClients: Map<string, OriginClient>
	ledger: Ledger
	validator: SchemaValidator
	seed: number
	/** Fresh per run: the seed reproduces a run, the nonce keeps two runs' records apart. */
	nonce: string
	outOfBand: BackoffConfig
}

/** What this run grades, and what it may call. */
export interface Planned extends Connected {
	scope: TargetScope
	grades: GradeLedger
	/** Creates the principals' auth flows send: support, never seeded as fixtures. */
	authCreates: Set<string>
	/** Scenarios of this origin; a secondary origin's run its own. */
	ownScenarios: Scenario[]
	/** Operations a scenario covers: the matrix never generates a body for them. */
	scenarioOwned: Set<string>
	uploads: UploadContext
}

/** Everything a stage after authentication may use. */
export interface RunContext extends Planned {
	principals: RunPrincipals
	exclusion: Exclusion
	targetVersion: TargetVersion | undefined
}

/** A configured principal, able to produce its headers on demand. */
export interface ResolvedPrincipal {
	id: string
	headers: () => Record<string, string>
	/** Swap the credential this principal sends. Static headers and auth flows both implement it. */
	adoptCredential: (token: string) => void
	roots: Record<string, string>
	role: string | undefined
	rank: number
	inviteAs: string | undefined
	runtime?: PrincipalRuntime
}

/** The run's principals, and who owns and may remove what they create. */
export interface RunPrincipals {
	all: ResolvedPrincipal[]
	/** The first principal: the one the matrix acts as. */
	alpha: ResolvedPrincipal
	ownerOf(principal: ResolvedPrincipal): Owner
	/** Who else may remove a record its creator could not: a stronger principal of its tenant. */
	fallbackDeleters(owner: Owner): Owner[]
	/** Ledgers a record `owner` created. */
	recorder(owner: Owner): (entity: string, id: ProvenId, values: Record<string, string>) => void
	/** Ledgers a record learned of another way, as whoever sent the request that made it. */
	recordCreated(entity: string, id: ProvenId, values: Record<string, string>, principal?: string): void
	unidentified(entity: string, operationId: string, exchange: Exchange): void
	/** Refreshes every credential that is stale; false, with a finding, when one cannot be. */
	refreshAll(where: string): Promise<boolean>
}

/** What the active profile lets the run call. */
export interface Exclusion {
	/** Whether oat may call `op` at all: a read that confirms a create is still a call. */
	readable(op: OperationModel): boolean
	/** Whether the profile excludes the operation by this id. */
	excludes(operationId: string): boolean
	/**
	 * Whether the profile excludes `op` on `entity`. The first time, the exclusion is recorded and
	 * reported as a gap: checks that depend on the operation stand down rather than run against
	 * data oat did not create through it.
	 */
	excludeOp(entity: EntityModel, op: OperationModel | undefined): boolean
}
