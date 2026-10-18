import type { Hooks } from "../../config/types/hooks.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { OperationObject } from "../../spec/types.ts"
import type { Client } from "../../client/client.ts"
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
export interface ContractInput {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	checksRun: Set<string>
	validator: SchemaValidator
	auth: () => Record<string, string>
	roots: Record<string, string>
	hooks: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	seed: number
	nonce: string
	/** Operations a scenario owns. Its verdict stands, even when it stopped before them. */
	owned: ReadonlySet<string>
	/** True once the run was interrupted or the network is gone: send nothing more. */
	stopped: () => boolean
}

/** What confirming a delete reads and grades with. */
export interface ConfirmInput {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	auth: () => Record<string, string>
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	stopped: () => boolean
}
