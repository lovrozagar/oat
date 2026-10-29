/** The entity graph's shapes: each operation as oat reads it, each entity, and the model they form. */

import type { SecurityScheme } from "../security/schemes.ts"
import type { ResolvedSecurity } from "../security/requirements.ts"
import type { CollectionShape } from "../collection/shape.ts"
import type { QueryConventions } from "../conventions/types.ts"
import type { AsyncSpec, WaitSpec } from "../extensions/async.ts"
import type { ConsistencySpec } from "../extensions/consistency.ts"
import type { EffectSpec } from "../extensions/effects.ts"
import type { EntityAction } from "../extensions/entity.ts"
import type { GapCollector } from "../extensions/gaps.ts"
import type { InviteSpec } from "../extensions/invite.ts"
import type { QueryCapability } from "../extensions/query-tag.ts"
import type { RateLimitTag } from "../extensions/flags.ts"
import type { OperationObject } from "../types.ts"
import type { ParamStyles } from "./parameters.ts"

export interface OperationModel {
	operationId: string
	method: string
	path: string
	route: string
	entity: string | null
	action: EntityAction | null
	entitySource: "tag" | "heuristic" | null
	invalidates: string[]
	/** `x-consistency`: the read's staleness bound and cache bypass; null when undeclared. */
	consistency: ConsistencySpec | null
	effects: EffectSpec[]
	/** The operation declares it has no effects (`x-effects: []`): its contract is the whole promise. */
	noEffects: boolean
	async: AsyncSpec | null
	/** Documented success response lists `text/event-stream`. Media type is the stream signal. */
	eventStream: boolean
	tenantParam: string | null
	/** Whether tenancy was declared via `x-tenant` or merely guessed from the path. */
	tenantSource: "tag" | "heuristic" | null
	pathParams: string[]
	/**
	 * Request body properties marked `x-privileged: true`, nested ones by dotted path: only the
	 * highest-rank principal may set them.
	 */
	privileged: string[]
	/** The `privileged` paths the body requires: a create only the highest rank can send. */
	privilegedRequired: string[]
	rootParams: string[]
	queryParamNames: string[]
	/**
	 * Required query parameters and the value the document declares for each, an object or array
	 * kept whole. A request the document calls incomplete without one is sent with it; a parameter
	 * with no declared value is left to the caller, never invented.
	 */
	requiredQuery: Record<string, unknown>
	/** Required header parameters and their declared values: never the idempotency key or a credential. */
	requiredHeaders: Record<string, unknown>
	/** Required cookie parameters and their declared values. */
	requiredCookies: Record<string, unknown>
	/** Each parameter's OAS style, explode and allowReserved, where they differ from the default. */
	paramStyles: ParamStyles
	/**
	 * Header parameter this operation accepts as an idempotency key, when it declares one.
	 *
	 * Read straight from the document rather than from a new meta tag: an API that promises replay
	 * safety publishes the header, and the promise is what makes the property testable.
	 */
	idempotencyHeader: string | null
	/** A success response declares an `ETag` header: the record's version a precondition can name. */
	etag: boolean
	/** The `If-Match` header parameter the operation declares, under its declared spelling. */
	ifMatch: string | null
	/** What this endpoint's query parameters and envelope mean, derived from the document. */
	conventions: QueryConventions
	/** Exact status codes the document names. Ranges and `default` live in `statuses`. */
	documentedStatuses: number[]
	statuses: DocumentedStatuses
	securitySchemes: string[]
	/** The credentials this operation needs: any one alternative, every scheme in it. */
	security: ResolvedSecurity
	collection: CollectionShape | null
	/** `x-entity.createdIdFrom`: where a create's answer puts the made record's id. */
	createdIdFrom: string | null
	/** `x-entity.recordPath`: where this operation's answer keeps the record, or a list's rows. */
	recordPath: string | null
	identity: string | null
	/** Where `identity` came from: an `x-entity` tag, the item route's parameter, or the schema alone. */
	identitySource: "declared" | "route" | "schema" | null
	query: QueryCapability | null
	immutable: string[]
	generated: string[]
	softDelete: string | null
	invite: InviteSpec | null
	wait: WaitSpec | null
	cost: "low" | "medium" | "high"
	/** Declared so a matching 403 is coverage, not a seed defect. */
	featureGate: string | null
	/**
	 * Declared unique column sets. `null` means the tag is absent or malformed (checks do not
	 * run). `[]` is explicit none. Non-empty lists are the sets `create.unique-conflict-rejected`
	 * and `update.unique-conflict-rejected` probe.
	 */
	unique: string[][] | null
	destructive: boolean
	idempotent: boolean
	freshPrincipal: boolean
	cleanup: string | null
	rateLimit: RateLimitTag | null
	hasRequestBody: boolean
	isMutation: boolean
	/**
	 * Why oat never sends this operation, or `null` when it can: a TRACE, which fetch refuses. The
	 * operation is listed, and a check that reaches it sends nothing.
	 */
	unsendable: string | null
}

export interface EntityModel {
	name: string
	identity: string | null
	create?: string
	list?: string
	read?: string
	/** Every read on this entity. `read` stays the first. */
	reads?: string[]
	update?: string
	delete?: string
	actions: string[]
	invite: InviteSpec | null
	/** Read routes through which an instance is observable — the criss-cross matrix. */
	readSurface: string[]
	/** Read routes contributed by `x-invalidate` rather than by sibling inference. */
	declaredSurface: string[]
	tenantParams: string[]
	trackable: boolean
	/** Effective unique sets for this entity (from create, else any tagged operation). */
	unique: string[][] | null
}

export interface SpecModel {
	operations: OperationModel[]
	byOperationId: Map<string, OperationModel>
	byRoute: Map<string, OperationModel>
	/** The untouched operation objects, keyed by id — schemas are read from here. */
	rawOperations: Map<string, OperationObject>
	/** Recursive schemas the dereferenced document refers to as `oat-defs#/$defs/<name>`. */
	defs: Record<string, Record<string, unknown>>
	entities: Map<string, EntityModel>
	roots: string[]
	gaps: GapCollector
	securitySchemes: string[]
	/** Every declared security scheme, read: where its credential goes, or why oat cannot send it. */
	schemes: ReadonlyMap<string, SecurityScheme>
	hasAuthOperations: boolean
}

/**
 * The responses an operation documents: exact codes, `NXX` ranges, and `default`.
 *
 * Parsing the keys as integers read `2XX` as status 2 and dropped `default` entirely, so a
 * document written in ranges declared nothing a real status could match.
 */
export interface DocumentedStatuses {
	exact: number[]
	/** Status classes documented as a range: 2 for `2XX`. */
	ranges: number[]
	default: boolean
}
