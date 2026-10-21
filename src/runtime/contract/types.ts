import type { Hooks, Sends } from "../../config/types/hooks.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { OperationObject } from "../../spec/types.ts"
import type { Client } from "../../client/client.ts"
import type { Actor } from "../../client/credential-source.ts"
import type { ActionBind } from "../effects/bind.ts"
import type { FindingCollector } from "../finding.ts"
import type { GradeLedger } from "../grades.ts"
import type { SchemaValidator } from "../validate.ts"
import type { Parameter } from "./params.ts"

/** The operation a contract call is built for: its model, its document object, its declared parameters and its `x-bind`. */
export interface ContractCall {
	op: OperationModel
	raw: OperationObject
	params: readonly Parameter[]
	bind: ActionBind | null
}

/** What the contract floor reads and grades with. */
/** Who the floor acts as, and what it would send on an operation: what `hooks.resolvePathValue` is told. */
export interface Acting {
	identity: Readonly<Record<string, unknown>>
	/** The credential an operation would carry as the principal, and its placement; undefined when it sends none. */
	sending: (operationId: string) => Promise<{ credential: string; sends: Sends } | undefined>
}

/**
 * The operations behind the run's credentials, and who calls one: never a principal's own session,
 * which the call could end, rotate or spend, but a dedicated one, or nobody where none is needed.
 */
export interface FloorCredentials {
	/** Every operation a recipe names: a login or refresh step, a revoke, a mint. */
	operations: ReadonlySet<string>
	/**
	 * A sign-in step's body fields that name the principal, by the step's operation: each a path of
	 * keys. The floor sends those with an identity no account holds, never a generated one that
	 * could be a real account's.
	 */
	identityFields: ReadonlyMap<string, readonly (readonly string[])[]>
	/** Who sends `op`, or why nobody can without the principal's own session: then it is untested. */
	actorFor: (op: OperationModel) => Promise<{ as: Actor } | { untested: string }>
}

export interface ContractInput {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	checksRun: Set<string>
	validator: SchemaValidator
	/** The principal it sends as: `as: { principal }`, the operation's security choosing the scheme. */
	principal: string
	acting: Acting
	credentials: FloorCredentials
	roots: Record<string, string>
	hooks: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	seed: number
	nonce: string
	/** Operations a scenario owns. Its verdict stands, even when it stopped before them. */
	owned: ReadonlySet<string>
	/**
	 * Whether this run made the record of `entity` with `id`, removed since or not: the run's own
	 * evidence, never an id an answer merely showed. A write is sent to no other record.
	 */
	madeByRun: (entity: string, id: string) => boolean
	/** True once the run was interrupted or the network is gone: send nothing more. */
	stopped: () => boolean
}

/** What confirming a delete reads and grades with. */
export interface ConfirmInput {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	/** The principal it sends as: `as: { principal }`, the operation's security choosing the scheme. */
	principal: string
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	stopped: () => boolean
}
