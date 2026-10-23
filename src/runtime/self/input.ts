import type { Client } from "../../client/client.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import type { FindingCollector } from "../finding.ts"
import type { OwnRecords } from "../own-record.ts"

/* What the self-identity check is given: who it acts as, through which client, on which entity. */

export interface SelfInput {
	/** The principal it sends as: `as: { principal }`, the operation's security choosing the scheme. */
	principal: string
	client: Client
	entity: EntityModel
	findings: FindingCollector
	model: SpecModel
	nonce?: string
	resolveInput?: Hooks["resolveInput"]
	seed?: number
	/** What guards the caller's own record: a write there never changes how it signs in. */
	ownRecords?: OwnRecords
}
