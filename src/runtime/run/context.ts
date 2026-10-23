import type { Hooks } from "../../config/types/hooks.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import type { Exchange } from "../exchange.ts"
import type { ProvenId } from "../proven-id.ts"
import type { Scenario } from "../../config/types/steps.ts"
import type { OriginClient } from "../steps/request.ts"
import type { Client } from "../../client/client.ts"
import type { ExchangeJournal } from "../exchanges/journal.ts"
import type { Fence } from "../fence.ts"
import type { FindingCollector } from "../finding.ts"
import type { BackoffConfig } from "../poll.ts"
import type { ResolvedProfile } from "../profile.ts"
import type { GradeLedger } from "../grades.ts"
import type { TargetScope } from "../scope/types.ts"
import type { TargetVersion } from "../target-version.ts"
import type { AccountLedger } from "../accounts/ledger.ts"
import type { Ledger } from "../teardown/ledger.ts"
import type { Created, Owner } from "../teardown/types.ts"
import type { UploadContext } from "../upload.ts"
import type { SchemaValidator } from "../validate.ts"
import type { CredentialStore } from "../../credentials/store.ts"
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
	/**
	 * Each secondary origin's document, read and modelled once at load, where the config's
	 * credentials are checked against it. By origin id; each origin's client is built on it.
	 */
	origins: ReadonlyMap<string, LoadedOrigin>
	state: RunState
}

/** A secondary origin's document, after its overlay, and its model. */
export interface LoadedOrigin {
	doc: OpenApiDocument
	model: SpecModel
}

/** A client to talk to the API with, and what records the run's exchanges and fixtures. */
export interface Connected extends Loaded {
	client: Client
	/**
	 * The run's credentials, one store for the run: the primary client and each origin's resolve
	 * their actors over it, each against its own document.
	 */
	store: CredentialStore
	journal: ExchangeJournal | null
	network: RunNetwork
	originClients: Map<string, OriginClient>
	ledger: Ledger
	/** Every account the run asked a backend to make, ledgered before each request went out. */
	accounts: AccountLedger
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

/** A principal the run acts as: who it is, its tenant and rank, and the parameters bound for it. */
export interface RunPrincipal {
	id: string
	/** What its recipes interpolate as `{principal.<key>}`: config data, a fresh signup's values, a login's claims. */
	identity: Readonly<Record<string, unknown>>
	/** From the config, or bound by a login's `claims`. */
	tenant?: string
	/** Higher can do everything a lower rank can. */
	rank: number
	/** Path or query parameters bound for it: the config's `scope`, then a login's `scope.<param>` claims. */
	scope: Readonly<Record<string, string>>
	/** What an owner puts in an invite body for it. */
	inviteAs?: string
	/** The config marks the account read-only: a viewer, whose every write must be refused. */
	readOnly?: true
	/** Signed up by this run through the document's `x-fresh-principal` operation. */
	fresh: boolean
}

/** The run's principals, who is isolated from whom, and who owns and may remove what they create. */
export interface RunPrincipals {
	/** Every principal not BLOCKED, in config order. */
	all: RunPrincipal[]
	/** The first: the one the matrix acts as. */
	alpha: RunPrincipal
	byId: ReadonlyMap<string, RunPrincipal>
	/** The first principal of a tenant other than `principal`'s: what isolation reads and writes across. */
	peerOf(principal: RunPrincipal): RunPrincipal | undefined
	sameTenant(a: RunPrincipal, b: RunPrincipal): boolean
	/** Principals whose login failed, each reported once; the run goes on without them. */
	blocked: ReadonlyArray<{ id: string; reason: string }>
	ownerOf(principal: RunPrincipal): Owner
	/** Who else may remove a record its creator could not: a stronger principal of its tenant. */
	fallbackDeleters(owner: Owner): Owner[]
	/** Ledgers a record `owner` created. */
	recorder(owner: Owner): (entity: string, id: ProvenId, values: Record<string, string>) => void
	/** Ledgers a record learned of another way, as whoever sent the request that made it. */
	recordCreated(created: Created, principal?: string): void
	unidentified(entity: string, operationId: string, exchange: Exchange): void
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
