/** Everything one reference server holds between requests. */

import type { DefectSet } from "../defects/defect-set.ts"
import type { Dialect } from "../dialect/types.ts"
import type { EntityDef } from "../model/types.ts"
import type { QueryConventions } from "../query/conventions.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import type { Row, Store } from "../store-api.ts"
import type { Ids } from "./ids.ts"

export interface Principal {
	key: string
	token: string
	projectId: string
	/** Higher can do everything a lower rank can. Viewer 0, member 1, owner 2. */
	rank: number
}

export const PRINCIPALS: readonly Principal[] = [
	{ key: "key_alpha", projectId: "proj_alpha", rank: 2, token: "tok_alpha" },
	{ key: "key_beta", projectId: "proj_beta", rank: 2, token: "tok_beta" },
	{ key: "key_alpha_member", projectId: "proj_alpha", rank: 1, token: "tok_alpha_member" },
	{ key: "key_alpha_viewer", projectId: "proj_alpha", rank: 0, token: "tok_alpha_viewer" },
]

export const TENANT_FIELD = "project_id"

/** Path parameters, typed: an integer identifier is a number from the moment it is parsed. */
export type Scope = Record<string, string | number>

/** A collection: an entity, under the path scope that names it. */
export interface Collection {
	entity: EntityDef
	scope: Scope
}

/** A stored record, with the entity it is a record of. */
export interface EntityRecord {
	entity: EntityDef
	record: Row
}

/** Where one record is kept: its entity and its identifier. */
export interface RecordKey {
	entity: EntityDef
	id: string | number
}

export interface ReferenceOptions {
	defects?: string[]
	untagged?: boolean
	dialect?: string
	/** A correct API shape oat was not written against — by name, or spelled out. */
	shape?: string | ReferenceShape
}

/** An invitation to a table: readable by the invitee once accepted, until revoked. */
export interface Grant {
	accepted: boolean
	entity: string
	grantId: string
	granteeKey: string
	resourceId: string
	token: string
}

export interface ReferenceState {
	untagged: boolean
	defects: DefectSet
	shape: ReferenceShape
	dialect: Dialect
	entities: readonly EntityDef[]
	table: EntityDef
	job: EntityDef
	conventions: QueryConventions
	basePath: string
	updateMethod: string
	store: Store
	/** The store as a listing sees it: under HIDDEN_FROM_CREATOR, hidden rows are not there. */
	listingStore: Store
	ids: Ids
	/** When each started job began, to advance it on read. */
	jobStartedAt: Map<string, number>
	/** Snapshot of a collection taken before a write, replayed while STALE_LIST is on. */
	staleSnapshot: Map<string, Row[]>
	/** Entities whose first listing has already been refused, for RATE_LIMIT_STRICTER_THAN_DECLARED. */
	throttled: Set<string>
	/** Idempotency-Key → the record the first request created, so a replay returns it. */
	idempotent: Map<string, Row>
	/** Delivered notifications, per project. */
	inboxes: Map<string, Array<{ id: string; message: string }>>
	grants: Map<string, Grant>
	/** The caller's own profile, per token. */
	profiles: Map<string, { first_name: string }>
	/** Tokens a request may present: the principals', and any a registration issued since. */
	liveTokens: Set<string>
	/** Under `tableKey: "slug"`, each table's slug by its internal id: the identity a client knows. */
	slugOf: Map<string, string>
}
