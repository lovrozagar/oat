/**
 * The check registry.
 *
 * Each check asserts one property that must hold for any correct implementation. They need no
 * ground truth — they compare the API against itself, through independent projections, or against
 * the oracle of what oat just wrote. Check ids are stable: the conformance suite asserts on them.
 */

import type { Hooks, PayloadPolicy } from "../config/define-config.ts"
import { canWriteFilterOp, filterTerm, selectTerm, sortTerm, sortTermWithNulls } from "../spec/conventions.ts"
import type { InviteSpec } from "../spec/extensions.ts"
import { CHECK_IDS, type CheckId } from "./check-ids.ts"
import { publicGetCheck } from "./one-shot.ts"
import { selfIdentityCheck } from "./self.ts"
import type { QueryCapability } from "../spec/extensions.ts"
import {
	type EffectiveFilterField,
	type EffectiveQueryCapabilities,
	FILTER_OPS,
	ORDERED_TYPES,
	fieldAllows,
	fieldAllowsNulls,
	isFilterOp,
	mergeQueryCapabilities,
	opsAreClosed,
	opsForField,
} from "../spec/query-capabilities.ts"
import { requestContent } from "../spec/collection.ts"
import {
	type EntityModel,
	type OperationModel,
	type SpecModel,
	describeSuccess,
	documentedPage,
	documentsStatus,
	largestPageQuery,
	readStatuses,
} from "../spec/graph.ts"
import type { OperationObject } from "../spec/types.ts"
import { encodeForOperation } from "./body.ts"
import { absentIdentifier, distinctValue, filterSentinel, outsideEnum, overMaxLength } from "./generate.ts"
import { normalizeSchema } from "../spec/schema.ts"
import type { Client, Exchange, ReadClient, RequestOptions } from "./client.ts"
import { REQUIRED_IDS, STRING_PAYLOADS, type StringPayload, payloadFits } from "./payloads.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "./feature-gate.ts"
import { headerValue } from "./headers.ts"
import { readPath } from "./path.ts"
import { ASSERTED, asserted, type FindingCollector, type Outcome, standDown } from "./finding.ts"
import { driveAsync, inspectStreamAsync, matchesPredicate, resolveAsyncId } from "./async.ts"
import { resolveOutOfBandValue } from "./auth.ts"
import { isAbsoluteHttpUrl } from "./cookies.ts"
import { buildCohort } from "./fixture.ts"
import type { BackoffConfig } from "./poll.ts"
import type { UploadContext } from "./upload.ts"
import { forEachInvocation } from "./upload-each.ts"
import type { SchemaValidator } from "./validate.ts"
import { driveWait } from "./wait.ts"
import { type Record_, fillPath, isPlanLimitResponse } from "./world.ts"
import {
	bodyPropertyNames,
	collisionCreateBody,
	collisionUpdatePatch,
	idempotencyHeaderRequired,
	probeableUniqueSets,
	uniquifyProbeBody,
	uniqueProbeHeaders,
} from "./unique.ts"
import {
	bindAfterCreateEffects,
	bindCreatedScope,
	applyActionBind,
	bindActionScope,
	bindInstanceScope,
	bindMissingPathParams,
	readActionBind,
	readBefore,
	canFillPath,
	describeEffectHold,
	effectHolds,
	identityPathParam,
} from "./effects.ts"

/** A resolved principal as checks see it — identity, lattice position, and how to speak as it. */
export interface Actor {
	id: string
	role: string | undefined
	/** Higher can do everything a lower rank can. Same rank = peers. */
	rank: number
	headers: () => Record<string, string>
	/**
	 * Replace this actor's credential after a response issues a new one.
	 * Static principals and auth flows both implement it. Absent means the actor cannot.
	 */
	adoptCredential?: (token: string) => void
	/** Tenant identity from config / the auth flow — not the full path scope. */
	roots: Record<string, string>
	scope: Record<string, string>
	/** Value the owner puts in an invite body for this principal. */
	inviteAs: string | undefined
}

/**
 * What a check runs against. A check that does not mutate gets a client that cannot write; a
 * helper that writes asks for a `WriteContext`, so a read-only check calling it does not compile.
 */
export interface CheckContext<C extends ReadClient = ReadClient> {
	entityName: string
	identity: string
	model: SpecModel
	client: C
	findings: FindingCollector
	scope: Record<string, string>
	listOp: OperationModel
	readOp: OperationModel | undefined
	createOp: OperationModel | undefined
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
	collectionKey: string | null
	records: Record_[]
	query: QueryCapability | null
	/** Merged filter catalog. Optional so a hand-built context still works. */
	capabilities?: EffectiveQueryCapabilities
	softDelete: string | null
	invite: InviteSpec | null
	auth: () => Record<string, string>
	/** Countdown / 401 refresh for the writer principal. Bound onto the client as well. */
	refreshIfStale?: (force?: boolean) => Promise<void>
	/**
	 * Every configured principal, primary first. Isolation checks still use `altAuth` (the first
	 * actor whose scope is a different tenant). Lattice checks walk this list by `rank`.
	 */
	actors: Actor[]
	/** Principal in a different tenant, when one is configured. Derived, not `principals[1]`. */
	altAuth: (() => Record<string, string>) | undefined
	altScope: Record<string, string> | undefined
	validator: SchemaValidator | undefined
	seed: number
	/** Per-run token for values that must not collide across runs: unique columns, idempotency keys. */
	nonce: string
	/** Effective unique column sets for this entity (`[]` when the tag is absent or empty). */
	uniqueSets: string[][]
	/** First-variant create 409 adopted a same-tenant row; unique probes still run. */
	uniqueAdopted: boolean
	/** Create operation for unique probes — still set after unique-409 adopt. */
	uniqueCreateOp: OperationModel | undefined
	/** Update operation for unique probes — still set after unique-409 adopt. */
	uniqueUpdateOp: OperationModel | undefined
	/** File pool / dummy resolution for multipart parts. */
	uploads: UploadContext
	/** Operations on this entity declared async via `x-async`. */
	asyncOps: OperationModel[]
	/** Operations on this entity that declare `x-effects`. */
	effectOps: OperationModel[]
	/** Operations on this entity that declare `x-wait`. */
	waitOps: OperationModel[]
	hooks: Hooks
	outOfBand: BackoffConfig
	/**
	 * The payload policy, and the write paths that have had the whole catalog this run — keyed
	 * by media type and field type, naming the entity that ran it. Optional so a hand-built
	 * context still works; absent means the whole catalog.
	 */
	payloads?: { policy: PayloadPolicy; ran: Map<string, string> }
	/**
	 * Whether an operation is graded by this run. Always true on a full run. Checks that judge
	 * several operations consult it before invoking or judging one. Optional so a hand-built
	 * context still works.
	 */
	inScope?: (op: OperationModel) => boolean
	/**
	 * Registers a record this check caused to exist — a declared effect, a started job — for
	 * teardown. Records made through the entity's own create are tracked without it.
	 */
	recordCreated?: (entity: string, id: string, scope: Record<string, string>) => void
	/**
	 * Narrows what this check graded to the operations it actually judged. A check that judges
	 * after the fact — from whatever the transcript happens to hold — calls it, so an operation
	 * nothing ever exercised is not reported as held. Checks that invoke their subjects need not.
	 */
	judged?: (operationIds: readonly string[]) => void
}

/** The context of a check that changes server state. */
export type WriteContext = CheckContext<Client>

const graded = (ctx: CheckContext, op: OperationModel): boolean => ctx.inScope?.(op) ?? true

/* ------------------------------------------------------------------- invented values */

/** This entity's identifier as its item route takes it: the path parameter's schema, else the record's. */
function identifierSchema(ctx: CheckContext): Record<string, unknown> {
	for (const op of [ctx.readOp, ctx.deleteOp, ctx.updateOp]) {
		if (op === undefined) continue
		const name = op.pathParams.at(-1)
		const raw = ctx.model.rawOperations.get(op.operationId)
		const declared = (raw?.parameters ?? []).find(
			(parameter) => "name" in parameter && parameter.in === "path" && parameter.name === name,
		) as { schema?: Record<string, unknown> } | undefined
		if (declared?.schema !== undefined) return declared.schema
	}
	const properties = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
	return properties[ctx.identity] ?? { type: "string" }
}

/**
 * An identifier of the right shape that names nothing. A probe in the wrong format is answered
 * with a 400 before existence is ever considered, and comparing that with a real 404 reads as a
 * leak that is not there.
 */
function absentId(ctx: CheckContext): string | null {
	return constructedAbsentId(ctx)
}

const NO_ABSENT_ID = "an identifier of the documented shape that names no record"

/** A well-formed identifier that names nothing, or `null` when the identifier schema allows none. */
function constructedAbsentId(ctx: CheckContext): string | null {
	const made = absentIdentifier(identifierSchema(ctx), ctx.nonce ?? "oat")
	return made.ok ? String(made.value) : null
}

/** The schema of `field` as the item's representation declares it. */
function propertySchemaOf(ctx: CheckContext, field: string, op?: OperationModel): Record<string, unknown> | undefined {
	const request = op === undefined ? null : requestSchemaOf(ctx, op)
	const fromRequest = (request?.properties as Record<string, Record<string, unknown>> | undefined)?.[field]
	if (fromRequest !== undefined) return normalizeSchema(fromRequest, { direction: "request" })
	const item = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
	return item[field] === undefined ? undefined : normalizeSchema(item[field], { direction: "request" })
}

/** The statuses that mean "refused for this reason", by what a negative probe gets wrong. */
const REFUSED_FOR = {
	conflict: [409],
	"content-type": [415],
	validation: [400, 422],
} as const satisfies Record<string, readonly number[]>

/**
 * Judges the answer to a request sent to be refused. `null` when it was accepted, which the
 * caller judges. Only the statuses that mean "refused for this reason" assert the property; a 5xx
 * is a finding; any other refusal — unauthorized, forbidden, not found, rate limited — turned the
 * request away before the property was ever consulted, so nothing was learned.
 */
function judgeRefusal(
	ctx: CheckContext,
	check: string,
	reasons: ReadonlyArray<keyof typeof REFUSED_FOR>,
	exchange: Exchange,
): Outcome | null {
	const status = exchange.status
	if (status > 0 && status < 400) return null
	if (reasons.some((reason) => (REFUSED_FOR[reason] as readonly number[]).includes(status))) return ASSERTED
	if (status >= 500) {
		return ctx.findings.backend(
			check,
			ctx.entityName,
			"a request that should be refused drew a server error",
			`${exchange.method} ${exchange.url} returned ${status}; invalid input should be refused with ` +
				`${reasons.flatMap((reason) => REFUSED_FOR[reason]).join(" or ")}, not crash the handler.`,
			[exchange],
		)
	}
	return ctx.findings.unresolved(
		check,
		ctx.entityName,
		`the probe was turned away with ${status}, which does not say the input itself was refused`,
	)
}

/**
 * The context for a request oat sends expecting it to be refused. Its exchanges are marked as
 * probes, so a status the document leaves out for deliberately invalid input is reported apart
 * from what ordinary traffic got.
 */
function asProbe<C extends ReadClient>(ctx: CheckContext<C>): CheckContext<C> {
	return { ...ctx, client: ctx.client.view({ purpose: "probe" }) as C }
}

/** A valid value for `field` that differs from `current` — what a write probe changes it to. */
function changedValue(ctx: CheckContext, field: string, current: unknown, op?: OperationModel): unknown {
	const schema = propertySchemaOf(ctx, field, op)
	if (schema === undefined) return undefined
	const made = distinctValue(schema, current, { defs: ctx.model.defs, nonce: ctx.nonce, variant: "lexical-last" })
	return made.ok ? made.value : undefined
}

/** The context a multi-operation check uses for one subject: its findings land on that operation. */
function forOperation<C extends ReadClient>(ctx: CheckContext<C>, op: OperationModel): CheckContext<C> {
	return { ...ctx, findings: ctx.findings.attributed([op.operationId]) }
}

/**
 * What a check's planning step decided: it can run, with what it needs to — or it cannot, and why.
 *
 * Planning is the only place a check decides whether it applies, and `run` receives what the plan
 * found instead of looking again. A check that applies but then finds nothing to test cannot
 * happen by construction: the two questions are one.
 */
export type Plan<T> = { ok: true; value: T } | { ok: false; needs?: string }

export function ready<T>(value: T): Plan<T> {
	return { ok: true, value }
}

/** The check cannot run here; `needs` says what is missing, else the check's own `needs` does. */
export function cannot(needs?: string): Plan<never> {
	return needs === undefined ? { ok: false } : { ok: false, needs }
}

/** `next`, once `gate` holds — a plan built in stages, stopping at the first thing missing. */
export function andThen<A, T>(gate: Plan<A>, next: (value: A) => Plan<T>): Plan<T> {
	return gate.ok ? next(gate.value) : gate
}

/** A plan that carries nothing: the check applies exactly when `condition` holds. */
export function when(condition: boolean, needs?: string): Plan<undefined> {
	return condition ? { ok: true, value: undefined } : cannot(needs)
}

interface CheckBase<T> {
	id: CheckId
	/** Decides whether the check applies to this entity, and gathers what `run` needs if it does. */
	plan(ctx: CheckContext): Plan<T>
	/**
	 * Check ids whose failure makes this one's result meaningless. When any has already fired for
	 * this entity, the check is skipped rather than reporting a consequence as a separate defect —
	 * one root cause should produce one finding, not a page of them.
	 */
	dependsOn?: CheckId[]
	/**
	 * Whether the check judges traffic other checks sent. It runs after every check before it has
	 * finished, never alongside them, so it cannot miss what its batch-mates were still sending.
	 */
	judgesTranscript?: boolean
	/**
	 * What this check needs in order to run at all, in the reader's terms.
	 *
	 * Reported when the plan cannot run. Skipping silently would leave someone on an API
	 * shaped differently from the fixture believing a quiet run meant a clean one, when in truth
	 * half the suite never fired.
	 */
	needs?: string
	/**
	 * Operations whose contract this check judges, decided from the entity graph alone.
	 *
	 * Static so `oat plan --ops` can show a scope without a network, and so a targeted run can
	 * queue only the entities whose checks grade a target. Every other operation a check calls is
	 * support: needed to reach or observe a subject, never graded itself. Required, so a new check
	 * cannot run invisibly under `--ops`.
	 */
	subjects: (entity: EntityModel, model: SpecModel) => string[]
}

/**
 * Whether the check changes server state. Mutating checks run alone and in order, with a client
 * that can write; read-only checks batch together, with one that cannot. Two writers racing on
 * the same cohort would make each other's observations wrong, and the resulting finding would
 * describe the interference rather than the backend.
 */
export type Check<T = unknown> = CheckBase<T> &
	(
		| { mutates: true; run(ctx: WriteContext, plan: T): Promise<Outcome> }
		| { mutates?: false; run(ctx: CheckContext, plan: T): Promise<Outcome> }
	)

const declared = (...operationIds: Array<string | undefined>): string[] =>
	operationIds.filter((id): id is string => id !== undefined && id !== "")

const ownOps = (entity: EntityModel, model: SpecModel, keep: (op: OperationModel) => boolean): string[] =>
	model.operations.filter((op) => op.entity === entity.name && keep(op)).map((op) => op.operationId)

/** Subject sets shared by the registry. Each reads the same fields the check's context is built from. */
export const subjectsOf = {
	async: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.async !== null),
	asyncReceipt: (entity: EntityModel, model: SpecModel): string[] =>
		ownOps(entity, model, (op) => op.async?.idFrom !== undefined),
	create: (entity: EntityModel): string[] => declared(entity.create),
	createAndForeignReads: (entity: EntityModel, model: SpecModel): string[] => {
		const create = model.byOperationId.get(entity.create ?? "")
		if (create === undefined) return []
		const foreign = create.invalidates
			.map((route) => model.byRoute.get(route))
			.filter(
				(op): op is OperationModel =>
					op !== undefined && op.entity !== entity.name && op.method.toUpperCase() === "GET",
			)
			.map((op) => op.operationId)
		return [create.operationId, ...foreign]
	},
	createAndList: (entity: EntityModel): string[] => declared(entity.create, entity.list),
	delete: (entity: EntityModel): string[] => declared(entity.delete),
	deleteAndList: (entity: EntityModel): string[] => declared(entity.delete, entity.list),
	effects: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.effects.length > 0),
	invite: (entity: EntityModel): string[] =>
		entity.invite === null ? [] : declared(entity.invite.invite, entity.invite.accept, entity.invite.revoke),
	list: (entity: EntityModel): string[] => declared(entity.list),
	nonCreate: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.action !== "create"),
	read: (entity: EntityModel): string[] => declared(entity.read),
	readAndGated: (entity: EntityModel, model: SpecModel): string[] => [
		...new Set([...declared(entity.read), ...ownOps(entity, model, (op) => op.featureGate !== null)]),
	],
	readAndList: (entity: EntityModel): string[] => declared(entity.read, entity.list),
	update: (entity: EntityModel): string[] => declared(entity.update),
	waits: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.wait !== null),
	writeAndRead: (entity: EntityModel): string[] => declared(entity.update ?? entity.create, entity.read),
}

/* ------------------------------------------------------------------- helpers */

/**
 * A documented feature-gate 403 is not a 2xx-check failure and not SECURITY.
 *
 * The check that needed a success stands down with a named gap. The 403 body is still judged
 * against the documented error schema, by schema.error-response-matches-document.
 */
function standDownForFeatureGate(
	ctx: CheckContext,
	op: OperationModel | undefined,
	exchange: Exchange,
	check: string,
): boolean {
	if (op === undefined) return false
	if (!isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) return false
	/* The 403 body is judged against its schema by schema.error-response-matches-document. */
	ctx.findings.gap(
		check,
		ctx.entityName,
		`${op.operationId} did not apply`,
		`${describeFeatureGate(op, exchange.responseBody)}. The check that needed a 2xx stands ` +
			"down rather than treat the documented 403 as a defect.",
	)
	return true
}

/**
 * A 429 that survived Client retries is the bucket, not the backend. The check that needed a
 * 2xx stands down; it is not a defect and it is not a concurrency conclusion.
 */
function standDownForRateLimit(ctx: CheckContext, exchange: Exchange, check: string): boolean {
	if (exchange.status !== 429) return false
	ctx.findings.unresolved(
		check,
		ctx.entityName,
		"the request was rate-limited (429) after retries, so this check could not complete",
	)
	return true
}

/** The list endpoint's derived conventions — parameter roles and envelope spellings. */
function conv(ctx: CheckContext) {
	return ctx.listOp.conventions
}

/**
 * Builds a query using whatever this endpoint actually calls each role.
 *
 * `{ limit: 2, page: 1 }` becomes `?per_page=2&page_number=1` where that is how the document
 * spells them, so a check written once works against an API that shares no parameter names with
 * the fixture.
 */
function q(
	ctx: CheckContext,
	roles: {
		limit?: number | undefined
		page?: number | undefined
		cursor?: string | undefined
		order?: string | undefined
		search?: string | undefined
		searchMode?: string | undefined
		filter?: string | undefined
	},
): Record<string, string | number | undefined> {
	const c = conv(ctx)
	const out: Record<string, string | number | undefined> = {}
	/* Never above the documented maximum: a backend is right to refuse a request that breaks the
	 * contract, and reading that refusal as anything about the backend would be oat's own fault.
	 * The one check that probes past the cap on purpose sets the parameter itself. */
	const size = roles.limit === undefined ? undefined : Math.min(roles.limit, pageSize(ctx))
	if (size !== undefined && c.limit !== undefined) out[c.limit] = size
	if (roles.page !== undefined && c.page !== undefined) out[c.page] = roles.page
	else if (roles.page !== undefined && c.offset !== undefined) {
		/*
		 * Offset paging expressed from a page number.
		 *
		 * Some APIs count pages, some count rows skipped; the *property* every paging check is
		 * asserting — that walking forward covers the set without gaps or repeats — is identical
		 * either way. Translating here means a check says "page 3" once and works against both.
		 * Without it a page-numbered request against an offset API silently omits the parameter
		 * and every page comes back as the first one, which reads as a backend that ignores
		 * pagination rather than a tool that cannot express it.
		 */
		/* A page size must be assumed when the caller did not state one; 20 is the common default
		 * and any consistent value keeps the walk's arithmetic self-consistent, which is what the
		 * property depends on. */
		out[c.offset] = Math.max(roles.page - 1, 0) * (size ?? 20)
	}
	if (roles.cursor !== undefined && c.cursor !== undefined) out[c.cursor] = roles.cursor
	if (roles.order !== undefined && c.order !== undefined) out[c.order] = roles.order
	if (roles.search !== undefined && c.search !== undefined) out[c.search] = roles.search
	if (roles.searchMode !== undefined && c.searchMode !== undefined) out[c.searchMode] = roles.searchMode
	if (roles.filter !== undefined && c.filter !== undefined) out[c.filter] = roles.filter
	return out
}

/** The largest page this endpoint documents — see `documentedPage`. */
function pageSize(ctx: CheckContext): number {
	return documentedPage(ctx.model, ctx.listOp).size
}

/**
 * Whether an equality predicate can be expressed against this endpoint at all.
 *
 * Not "is there a `filter` parameter": the most common shape in the wild has no such parameter and
 * instead accepts one query parameter per field — `?status=active`. Gating on the parameter meant
 * every filter check silently skipped itself against those APIs, which is the same failure as a
 * check that cannot express a request being mistaken for a backend that ignores one.
 *
 * Checks needing an operator the grammar cannot write — a negation under equality-only filtering —
 * still stand down individually, because `filterTerm` returns null for them and there is genuinely
 * no request to send.
 */
function filterable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	if (c.filter !== undefined) return true
	/* Equality-per-field needs a field to attach the predicate to, and the document has to say
	 * which fields are filterable — otherwise oat would be guessing at parameter names. */
	return c.grammar === "equality" && (ctx.query?.filterable.length ?? 0) > 0
}

function resolvedCaps(ctx: CheckContext): EffectiveQueryCapabilities {
	if (ctx.capabilities !== undefined) return ctx.capabilities
	return mergeQueryCapabilities({
		itemSchema: ctx.listOp.collection?.itemSchema ?? null,
		tag:
			ctx.query === null
				? null
				: {
						filterable: ctx.query.filterable,
						searchable: ctx.query.searchable,
						selectable: ctx.query.selectable,
						sortable: ctx.query.sortable,
						source: ctx.query.source,
						...(ctx.query.filterableDeclared === undefined ? {} : { filterableDeclared: ctx.query.filterableDeclared }),
						...(ctx.query.sortableDeclared === undefined ? {} : { sortableDeclared: ctx.query.sortableDeclared }),
						...(ctx.query.searchableDeclared === undefined ? {} : { searchableDeclared: ctx.query.searchableDeclared }),
						...(ctx.query.selectableDeclared === undefined ? {} : { selectableDeclared: ctx.query.selectableDeclared }),
						...(ctx.query.filterFields === undefined ? {} : { filterFields: ctx.query.filterFields }),
						...(ctx.query.sortableFields === undefined ? {} : { sortableFields: ctx.query.sortableFields }),
						...(ctx.query.catalog === undefined ? {} : { catalog: ctx.query.catalog }),
						...(ctx.query.defaultOrder === undefined ? {} : { defaultOrder: ctx.query.defaultOrder }),
						...(ctx.query.stableTiebreak === undefined ? {} : { stableTiebreak: ctx.query.stableTiebreak }),
					},
	})
}

function filterableNames(ctx: CheckContext): string[] {
	return resolvedCaps(ctx).filterable.map((field) => field.field)
}

/** Filter field for identity predicates when it differs from the JSON identity. */
function filterIdentity(ctx: CheckContext): string {
	return resolvedCaps(ctx).identityFilter ?? ctx.identity
}

function identityIsFilterable(ctx: CheckContext): boolean {
	const names = filterableNames(ctx)
	return names.includes(filterIdentity(ctx)) || names.includes(ctx.identity)
}

function canUseOp(ctx: CheckContext, field: EffectiveFilterField, op: (typeof FILTER_OPS)[number]): boolean {
	return canWriteFilterOp(conv(ctx), op) && fieldAllows(field, op, resolvedCaps(ctx))
}

/**
 * Whether the endpoint can be walked forward at all, however it counts.
 *
 * Page numbers and row offsets are two ways of expressing the same request, and every paging
 * property — that walking forward covers the set without gaps or repeats, that a more-pages
 * signal is honest — holds identically under both. Gating those checks on a *page* parameter
 * meant an offset-paged API silently skipped them, which reads exactly like a clean result.
 */
function pageable(ctx: CheckContext): boolean {
	const c = conv(ctx)
	return c.page !== undefined || c.offset !== undefined
}

/**
 * Reads a pagination fact by whatever the document calls it — and from wherever it lives.
 *
 * Most APIs put these in the body. Some put them nowhere at all and publish a `Link` header
 * instead, in which case "are there more pages" is answered by the presence of `rel="next"`
 * rather than by a boolean field. Both are answers to the same question, so both are resolved
 * here and every check that asks stays unaware of the difference.
 */
function envelopeValue(ctx: CheckContext, result: ListResult, role: "total" | "hasMore" | "nextCursor"): unknown {
	const key = conv(ctx).envelope[role]
	if (key !== undefined) return result.envelope[key]

	const c = conv(ctx)
	if (c.linkHeader === undefined) return undefined
	/* The document declares a Link header, so its *absence* on a given response is meaningful:
	 * no `rel="next"` means there is no next page. Treating a missing header as "unknown" would
	 * let a backend that simply stops emitting links look untestable rather than wrong. */
	const link = linkRelations(result.exchange)
	if (role === "hasMore") return link?.has("next") ?? false
	if (role === "nextCursor") return link?.get("next") ?? null
	return undefined
}

/** Parses RFC 8288 `Link` into rel → URL, or null when the response carries no such header. */
function linkRelations(exchange: Exchange): Map<string, string> | null {
	const header = exchange.responseHeaders?.link ?? exchange.responseHeaders?.Link
	if (typeof header !== "string" || header === "") return null
	const relations = new Map<string, string>()
	for (const part of header.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim())
		if (match?.[1] !== undefined && match[2] !== undefined) relations.set(match[2].trim(), match[1])
	}
	return relations.size === 0 ? null : relations
}

interface ListResult {
	items: Record_[]
	envelope: Record<string, unknown>
	exchange: Exchange
}

async function list(
	ctx: CheckContext,
	query: Record<string, string | number | undefined> = {},
	auth = ctx.auth,
	scope = ctx.scope,
	op: OperationModel = ctx.listOp,
): Promise<ListResult> {
	const exchange = await ctx.client.get(fillPath(op.path, scope), {
		headers: auth(),
		operationId: op.operationId,
		query,
	})
	const body = exchange.responseBody
	const items = extractItems(body, op === ctx.listOp ? ctx.collectionKey : (op.collection?.key ?? null))
	return { envelope: (body ?? {}) as Record<string, unknown>, exchange, items }
}

/** The context as another entity's list operation sees it — for reading a set that is not ours. */
function forList<C extends ReadClient>(ctx: CheckContext<C>, op: OperationModel): CheckContext<C> {
	if (op === ctx.listOp) return ctx
	const entity = ctx.model.entities.get(op.entity ?? "")
	return {
		...ctx,
		collectionKey: op.collection?.key ?? null,
		identity: entity?.identity ?? "id",
		listOp: op,
		query: op.query,
	}
}

function extractItems(body: unknown, key: string | null): Record_[] {
	if (Array.isArray(body)) return body as Record_[]
	if (body === null || typeof body !== "object") return []
	if (key !== null) {
		const value = (body as Record<string, unknown>)[key]
		return Array.isArray(value) ? (value as Record_[]) : []
	}
	return []
}

function ids(records: Record_[], identity: string): string[] {
	return records.map((r) => String(r[identity]))
}

/**
 * How many pages a walk will traverse.
 *
 * Walking a whole collection is O(n) strictly sequential requests, so against a large existing
 * dataset it dominates the entire run — and buys nothing. Pagination defects manifest at the
 * *first* page boundary: a missing tiebreak, an off-by-one offset, a drifting cursor all show up
 * within the first few pages or not at all. Bounding the walk makes runtime independent of how
 * much data the system under test happens to be holding.
 */
const MAX_WALK_PAGES = 6

interface Walk {
	ids: string[]
	/** The records in the order the walk met them, repeats included. */
	items: Record_[]
	/** Every page the walk read. */
	exchanges: Exchange[]
	/** True when the walk stopped at the page cap rather than at the end of the collection. */
	truncated: boolean
}

/** What a whole-set read produced. */
interface SetRead {
	items: Record_[]
	/** True only when the API itself showed the set ended — see `readSet`. */
	complete: boolean
	/** The last page read. */
	last: ListResult
	pages: ListResult[]
	status: "ok" | "unresolved"
	/** Why the read is unresolved or incomplete. */
	reason?: string
}

interface ReadOptions {
	/** Page size to ask for; never above the documented maximum. */
	size?: number
	order?: string | undefined
	/** Bypass the memo: for checks that compare two reads of the same set. */
	fresh?: boolean
	/** Stop after this many pages even if the set continues. */
	maxPages?: number
	/** Keep walking when a page repeats records already seen — the page-walk check wants to see it. */
	keepRepeats?: boolean
	/** Page by cursor even where page numbers or offsets exist. */
	byCursor?: boolean
	auth?: () => Record<string, string>
	scope?: Record<string, string>
}

/** Identical set reads within one run, keyed by request and by how many writes came before. */
const setReads = new WeakMap<SpecModel, Map<string, Promise<SetRead>>>()
/** Page-number pages requested together once a walk is known to go past its first page. */
const PAGES_AHEAD = 4

/** Most records one set read will gather before reporting the set as larger than it covers. */
const SET_RECORD_CAP = 500

/**
 * Reads a whole result set — the one primitive every check that reasons about "all the records
 * matching X" goes through.
 *
 * It follows whatever the endpoint pages by: page numbers, row offsets, or a cursor. Offsets count
 * the records actually returned, so a server that quietly serves fewer than asked for is still
 * walked correctly. Completeness comes only from evidence the API gave: an empty page, a page
 * shorter than a full one already seen, a total reached, a missing next cursor. A "no more pages"
 * signal on a page that was full is checked by reading one more page — a wrong flag must not end
 * a walk, since a wrong flag is one of the things checks look for. The requested size proves
 * nothing on its own: a server may cap it without saying so.
 *
 * A page answered with an error leaves the set unresolved, never "ended". Identical reads are
 * shared until the next write, unless `fresh` asks for a new one.
 */
async function readSet(
	ctx: CheckContext,
	extra: Record<string, string | number | undefined> = {},
	options: ReadOptions = {},
): Promise<SetRead> {
	const size = Math.min(options.size ?? pageSize(ctx), pageSize(ctx))
	const memo = setReads.get(ctx.model) ?? new Map<string, Promise<SetRead>>()
	setReads.set(ctx.model, memo)
	const key = JSON.stringify([
		ctx.listOp.operationId,
		fillPath(ctx.listOp.path, options.scope ?? ctx.scope),
		(options.auth ?? ctx.auth)(),
		extra,
		size,
		options.order ?? null,
		options.maxPages ?? null,
		options.keepRepeats === true,
		options.byCursor === true,
		ctx.client.writes,
	])
	if (options.fresh !== true) {
		const cached = memo.get(key)
		if (cached !== undefined) return cached
	}
	const pending = walkSet(ctx, extra, options, size)
	if (options.fresh !== true) memo.set(key, pending)
	return pending
}

async function walkSet(
	ctx: CheckContext,
	extra: Record<string, string | number | undefined>,
	options: ReadOptions,
	size: number,
): Promise<SetRead> {
	const c = conv(ctx)
	const mode =
		options.byCursor === true && c.cursor !== undefined
			? "cursor"
			: c.page !== undefined
				? "page"
				: c.offset !== undefined
					? "offset"
					: c.cursor !== undefined
						? "cursor"
						: "single"
	const items: Record_[] = []
	const pages: ListResult[] = []
	const seen = new Set<string>()
	let fullPage = 0
	let cursor: string | undefined
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY
	const finish = (complete: boolean, reason?: string): SetRead => ({
		complete,
		items,
		last: pages.at(-1) as ListResult,
		pages,
		status: "ok",
		...(reason === undefined ? {} : { reason }),
	})

	/*
	 * Page numbers are known in advance, so once the first page shows there is more to read, the
	 * next few are requested together. They are still judged one by one, in order, and whatever
	 * was fetched past the end is simply not read. Offsets and cursors depend on the page before.
	 */
	const ahead = new Map<number, Promise<ListResult>>()
	const fetchPage = (index: number): Promise<ListResult> => {
		const query: Record<string, string | number | undefined> = {
			...q(ctx, { limit: size, order: options.order }),
			...extra,
		}
		if (mode === "page" && c.page !== undefined) query[c.page] = index + 1
		if (mode === "offset" && c.offset !== undefined) query[c.offset] = items.length
		if (mode === "cursor" && c.cursor !== undefined && cursor !== undefined) query[c.cursor] = cursor
		return list(ctx, query, options.auth, options.scope)
	}
	for (let index = 0; ; index++) {
		if (index >= maxPages) return finish(false, `stopped after ${maxPages} page(s)`)
		if (mode === "page" && index > 0) {
			for (let next = index; next < Math.min(index + PAGES_AHEAD, maxPages); next++) {
				if (ahead.has(next)) continue
				const pending = fetchPage(next)
				/* A page fetched past the end is never awaited; its failure must not surface. */
				pending.catch(() => undefined)
				ahead.set(next, pending)
			}
		}
		const result = await (ahead.get(index) ?? fetchPage(index))
		pages.push(result)
		if (result.exchange.status >= 400) {
			return {
				complete: false,
				items,
				last: result,
				pages,
				reason: `page ${index + 1} was answered with ${result.exchange.status}`,
				status: "unresolved",
			}
		}
		const page = result.items
		if (page.length === 0) return finish(true)
		const fresh = page.filter((item) => !seen.has(String(item[ctx.identity])))
		/* A page holding nothing new means the server is not paging — the same window again. */
		if (fresh.length === 0 && options.keepRepeats !== true) return finish(false, "pages repeat the same records")
		for (const item of page) seen.add(String(item[ctx.identity]))
		items.push(...page)
		if (items.length >= SET_RECORD_CAP) return finish(false, `more than ${SET_RECORD_CAP} records`)
		if (mode === "single") return finish(true)

		if (mode === "cursor") {
			const next = envelopeValue(ctx, result, "nextCursor")
			if (typeof next !== "string" || next === "") return finish(true)
			cursor = next
			continue
		}

		/* A page shorter than a full one already seen is the last page. */
		if (fullPage > 0 && page.length < fullPage) return finish(true)
		fullPage = Math.max(fullPage, page.length)
		const total = envelopeValue(ctx, result, "total")
		const hasMore = envelopeValue(ctx, result, "hasMore")
		/* Where the envelope carries both, they must agree before either is believed: a total of
		 * zero beside a page of rows, or "no more" short of the total, is a signal lying — and a
		 * server that serves fewer rows than asked makes every page look like the last. */
		const totalSaysDone = typeof total === "number" && items.length >= total
		const saysDone =
			typeof total === "number" && typeof hasMore === "boolean"
				? totalSaysDone && !hasMore
				: totalSaysDone || hasMore === false
		/* Done, and the page was not full: the evidence agrees. Done on a full page, or nothing
		 * said at all: read one more page and let it decide. */
		if (saysDone && page.length < size) return finish(true)
	}
}

/**
 * A whole set, in the shape of one listed page: `items` holds every record, `exchange` is the last
 * page read. For checks written against a single page that reason about the whole set.
 */
async function listAll(
	ctx: CheckContext,
	query: Record<string, string | number | undefined>,
): Promise<ListResult & { complete: boolean }> {
	const c = conv(ctx)
	const extra: Record<string, string | number | undefined> = {}
	let order: string | undefined
	for (const [key, value] of Object.entries(query)) {
		if (key === c.limit || key === c.page || key === c.offset || key === c.cursor) continue
		if (key === c.order) order = value === undefined ? undefined : String(value)
		else extra[key] = value
	}
	const read = await readSet(ctx, extra, { order })
	return {
		complete: read.status === "ok" && read.complete,
		envelope: read.last.envelope,
		exchange: read.last.exchange,
		items: read.items,
	}
}

/**
 * Collects a whole result set — `readSet`, shaped for the set-algebra checks. `null` when a page
 * was refused, so the caller reports the check unresolved rather than reading "refused" as "empty".
 */
async function collectSet(
	ctx: CheckContext,
	requested: number,
	extra: Record<string, string> = {},
	order?: string,
): Promise<SetRead | null> {
	const read = await readSet(ctx, extra, { order, size: requested })
	return read.status === "ok" ? read : null
}

/** Walks pages in order, returning ids as encountered — repeats kept, since they are the finding. */
async function walkPages(
	ctx: CheckContext,
	pageSize: number,
	order?: string,
	maxPages = MAX_WALK_PAGES,
): Promise<Walk> {
	const read = await readSet(ctx, {}, { fresh: true, keepRepeats: true, maxPages, order, size: pageSize })
	return {
		exchanges: read.pages.map((page) => page.exchange),
		ids: ids(read.items, ctx.identity),
		items: read.items,
		truncated: !read.complete,
	}
}

async function walkCursor(
	ctx: CheckContext,
	pageSize: number,
	order?: string,
	maxPages = MAX_WALK_PAGES,
): Promise<Walk> {
	const read = await readSet(
		ctx,
		{},
		{ byCursor: true, fresh: true, keepRepeats: true, maxPages, order, size: pageSize },
	)
	return {
		exchanges: read.pages.map((page) => page.exchange),
		ids: ids(read.items, ctx.identity),
		items: read.items,
		truncated: !read.complete,
	}
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>()
	const dupes = new Set<string>()
	for (const value of values) {
		if (seen.has(value)) dupes.add(value)
		seen.add(value)
	}
	return [...dupes]
}

/**
 * A sortable field whose values repeat across the cohort. Ties are what expose an unstable sort:
 * with distinct keys every implementation looks correct, because there is only one valid order.
 */
function tiedSortField(ctx: CheckContext): string | null {
	return cohortFact(ctx, "tied-sort", () => computeTiedSortField(ctx))
}

function computeTiedSortField(ctx: CheckContext): string | null {
	for (const field of ctx.query?.sortable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => JSON.stringify(r[field]))
		if (new Set(values).size < values.length) return field
	}
	return null
}

/**
 * A field that is null on some seeded records and populated on others.
 *
 * Null handling is where query engines break — SQL's three-valued logic means `col <> x` is NULL
 * rather than true for null rows, so they silently vanish from negated predicates, and
 * nullsfirst/nullslast is easy to get backwards. A check that only ever probes the identity
 * column, which is never null, cannot see any of it.
 */
function nullableField(ctx: CheckContext, candidates: readonly string[]): string | null {
	return cohortFact(ctx, `nullable:${candidates.join(",")}`, () => computeNullableField(ctx, candidates))
}

function computeNullableField(ctx: CheckContext, candidates: readonly string[]): string | null {
	return candidates.find((field) => field !== ctx.identity && holdsSomeNulls(ctx, field)) ?? null
}

/** Null on some cohort records and set on others. */
function holdsSomeNulls(ctx: CheckContext, field: string): boolean {
	const nulls = ctx.records.filter((row) => row[field] === null || row[field] === undefined).length
	return nulls > 0 && nulls < ctx.records.length
}

function firstFilterable(ctx: CheckContext, predicate: (name: string) => boolean): string | null {
	return filterableNames(ctx).find(predicate) ?? null
}

function fieldsAllowing(ctx: CheckContext, op: (typeof FILTER_OPS)[number]): EffectiveFilterField[] {
	if (!canWriteFilterOp(conv(ctx), op)) return []
	return resolvedCaps(ctx).filterable.filter((field) => fieldAllows(field, op, resolvedCaps(ctx)))
}

function distinctValues(records: Record_[], field: string): unknown[] {
	const seen = new Set<string>()
	const out: unknown[] = []
	for (const record of records) {
		const value = record[field]
		if (value === null || value === undefined) continue
		const key = String(value)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(value)
	}
	return out
}

function asTermValue(value: unknown): string | number {
	return typeof value === "number" ? value : String(value)
}

function setOf(records: Record_[], identity: string): Set<string> {
	return new Set(ids(records, identity))
}

/** List identities that oat seeded. Extra rows outside this set are not scored as defects. */
function knownHits(items: Record_[], ctx: CheckContext): Set<string> {
	const known = setOf(ctx.records, ctx.identity)
	return new Set(ids(items, ctx.identity).filter((id) => known.has(id)))
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const item of a) if (!b.has(item)) return false
	return true
}

/**
 * Finds a record holding non-null values on two distinct, non-identity filterable fields — the
 * minimum needed to build a compound predicate that is guaranteed to match at least that record.
 */
function twoFilterableFields(ctx: CheckContext): { fieldA: string; fieldB: string; target: Record_ } | null {
	return cohortFact(ctx, "two-filterable", () => computeTwoFilterableFields(ctx))
}

function computeTwoFilterableFields(ctx: CheckContext): { fieldA: string; fieldB: string; target: Record_ } | null {
	const skip = new Set([ctx.identity, filterIdentity(ctx)])
	const candidates = filterableNames(ctx).filter((f) => !skip.has(f))
	for (const target of ctx.records) {
		const present = candidates.filter((f) => target[f] !== null && target[f] !== undefined)
		if (present[0] !== undefined && present[1] !== undefined) {
			return { fieldA: present[0], fieldB: present[1], target }
		}
	}
	return null
}

/** Two equality predicates on one record, and the two combined. */
interface Compound {
	fieldA: string
	fieldB: string
	valueA: string
	valueB: string
	termA: Record<string, string>
	termB: Record<string, string>
	combined: Record<string, string>
}

function compoundPlan(
	ctx: CheckContext,
	combine: (
		conventions: ReturnType<typeof conv>,
		fieldA: string,
		valueA: string,
		fieldB: string,
		valueB: string,
	) => Record<string, string> | null,
): Plan<Compound> {
	const picked = twoFilterableFields(ctx)
	if (picked === null) return cannot("a cohort record with values on two distinct filterable fields")
	const conventions = conv(ctx)
	const { fieldA, fieldB, target } = picked
	const valueA = String(target[fieldA])
	const valueB = String(target[fieldB])
	const termA = filterTerm(conventions, fieldA, "eq", valueA)
	const termB = filterTerm(conventions, fieldB, "eq", valueB)
	const combined = combine(conventions, fieldA, valueA, fieldB, valueB)
	if (termA === null || termB === null || combined === null) {
		return cannot("a filter grammar that can express a combined predicate")
	}
	return ready({ combined, fieldA, fieldB, termA, termB, valueA, valueB })
}

/** The bare `field.op.value` / `field=op:value` fragment `filterTerm` wraps in its parameter. */
function filterFragment(conventions: ReturnType<typeof conv>, field: string, value: string): string | null {
	const term = filterTerm(conventions, field, "eq", value)
	if (term === null) return null
	const fragment = Object.values(term)[0]
	return typeof fragment === "string" ? fragment : null
}

/**
 * A conjunction of two equality predicates, in whatever grammar the endpoint speaks.
 *
 * Per-field equality ANDs implicitly — two query parameters together already mean "both must
 * hold" — so the two terms are simply merged. A raw filter expression has no such shortcut: the
 * postgrest grammar needs an explicit `and(...)`, and the colon grammar (which has no grouping
 * syntax at all — see `toCanonicalFilter`) ANDs by joining terms with a comma.
 */
function andTerm(
	conventions: ReturnType<typeof conv>,
	fieldA: string,
	valueA: string,
	fieldB: string,
	valueB: string,
): Record<string, string> | null {
	if (conventions.grammar === "equality") {
		const a = filterTerm(conventions, fieldA, "eq", valueA)
		const b = filterTerm(conventions, fieldB, "eq", valueB)
		if (a === null || b === null) return null
		return { ...a, ...b } as Record<string, string>
	}
	if (conventions.filter === undefined) return null
	const a = filterFragment(conventions, fieldA, valueA)
	const b = filterFragment(conventions, fieldB, valueB)
	if (a === null || b === null) return null
	return { [conventions.filter]: conventions.grammar === "postgrest" ? `and(${a},${b})` : `${a},${b}` }
}

/**
 * A disjunction of two equality predicates.
 *
 * Only the postgrest grammar has an `or()` combinator at all: per-field equality has no way to
 * ask for "either" rather than "both", and the colon grammar's comma join is AND-only.
 */
function orTerm(
	conventions: ReturnType<typeof conv>,
	fieldA: string,
	valueA: string,
	fieldB: string,
	valueB: string,
): Record<string, string> | null {
	if (conventions.grammar !== "postgrest" || conventions.filter === undefined) return null
	const a = filterFragment(conventions, fieldA, valueA)
	const b = filterFragment(conventions, fieldB, valueB)
	if (a === null || b === null) return null
	return { [conventions.filter]: `or(${a},${b})` }
}

/* -------------------------------------------------------------------- checks */

const readAfterWrite: Check<{ id: string }> = {
	plan: (ctx) => {
		const target = ctx.records[0]
		return ctx.createOp === undefined || target === undefined ? cannot() : ready({ id: String(target[ctx.identity]) })
	},
	mutates: true,
	id: "list.read-after-write",
	needs: "a create operation and at least one seeded record",
	subjects: subjectsOf.createAndList,
	async run(ctx, { id }): Promise<Outcome> {
		const walkSize = pageSize(ctx)
		/*
		 * Walk by short page, never by `hasMore` alone: a backend whose more-pages signal is
		 * wrong would make a record on page two look like a lost write.
		 *
		 * Deliberately unsorted. STALE_LIST only freezes the default listing — adding `order`
		 * takes a live path and the defect vanishes. An unstable default order can hide a
		 * record for one walk; a repeat that finds it was never a lost write.
		 */
		const locate = async (): Promise<{
			status: "found" | "missing" | "unresolved"
			last: ListResult | null
			reason?: string
		}> => {
			const gathered = await collectSet(ctx, walkSize)
			if (gathered === null) return { last: null, reason: "the list was rejected", status: "unresolved" }
			if (gathered.items.some((item) => String(item[ctx.identity]) === id)) {
				return { last: gathered.last, status: "found" }
			}
			/* Absent from a walk that stopped early is not absent from the list. */
			if (!gathered.complete) {
				return {
					last: gathered.last,
					reason: gathered.reason ?? "the list could not be read whole",
					status: "unresolved",
				}
			}
			return { last: gathered.last, status: "missing" }
		}

		let located = await locate()
		/* A record that appears on a repeat walk was never lost — it was unreachable for one
		 * query. That is an ordering defect, which the pagination checks diagnose precisely;
		 * reporting it here as a lost write would name the wrong cause. This check is about
		 * records the list *never* shows. */
		for (let attempt = 0; attempt < 2 && located.status === "missing"; attempt++) {
			located = await locate()
		}
		/* Missing from every walk, but a walk crosses page boundaries, and a backend that pages
		 * wrongly loses records exactly there. A walk at the largest documented page size puts the
		 * boundaries elsewhere: a record it finds was lost to paging, which the pagination checks
		 * own, not to the write. */
		if (located.status === "missing") {
			const largest = Object.values(largestPageQuery(ctx.model, ctx.listOp))[0]
			/* When the walk already uses the largest size, one smaller moves the boundaries too. */
			const other = largest !== undefined && largest !== walkSize ? largest : walkSize > 1 ? walkSize - 1 : undefined
			const moved = other === undefined ? null : await collectSet(ctx, other)
			if (moved?.items.some((item) => String(item[ctx.identity]) === id) === true) return ASSERTED
		}
		if (located.status === "found") return ASSERTED
		if (located.status === "unresolved") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`${located.reason ?? "the list was rejected"}, so whether the write is visible cannot be decided`,
			)
		}

		const evidence: Exchange[] = located.last === null ? [] : [located.last.exchange]
		let detail = `created ${ctx.entityName} ${id} is absent from the list projection`
		if (ctx.readOp !== undefined) {
			const item = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
				headers: ctx.auth(),
			})
			evidence.push(item)
			if (item.status < 300) {
				detail =
					`created ${ctx.entityName} ${id} is served by the item route (${item.status}) but ` +
					"does not appear in the list route — the two projections disagree"
			}
		}
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"list projection does not reflect a completed write",
			detail,
			evidence,
		)
	},
}

function itemParamFor(ctx: CheckContext, id: string): Record<string, string> {
	const op = ctx.readOp ?? ctx.updateOp ?? ctx.deleteOp
	const param = op?.pathParams.at(-1)
	return param === undefined ? {} : { [param]: id }
}

/**
 * Isolation checks need a tenant boundary to have meaning. A public catalogue has neither
 * `x-tenant` nor a path parameter that looks like one; a 200 from another principal is the
 * contract, not a leak.
 */
function tenantBoundary(op: OperationModel | undefined): boolean {
	if (op === undefined) return false
	return !(op.tenantSource === null && (op.tenantParam === null || op.tenantParam === undefined))
}

const unknownFilterRejected: Check<{ unknownField: Record<string, string> }> = {
	/*
	 * Deliberately narrower than `filterable`: this asserts that a *filter expression* naming a
	 * field the document does not declare is rejected rather than dropped.
	 *
	 * Under one-parameter-per-field equality there is no expression language, so an unrecognised
	 * parameter is just an unrecognised query parameter — and ignoring those is conventional,
	 * widely relied upon, and not a defect. Reporting it as one would fire against a large share
	 * of real APIs, which is how a tool earns a reputation for crying wolf.
	 */
	plan: (ctx) => {
		const unknownField = conv(ctx).filter === undefined ? null : filterTerm(conv(ctx), "oat_no_such_field_xyz", "eq", 1)
		return unknownField === null ? cannot() : ready({ unknownField })
	},
	id: "filter.unknown-field-rejected",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	subjects: subjectsOf.list,
	async run(ctx, { unknownField }): Promise<Outcome> {
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: pageSize(ctx) }), ...unknownField })

		if (result.exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown filter field produces a server error",
				`filtering on an undeclared field returned ${result.exchange.status}; a rejected input ` + "should be a 4xx",
				[result.exchange],
			)
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused

		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown filter field is silently ignored",
			`filtering on an undeclared field returned ${result.exchange.status} with ` +
				`${result.items.length} of ${baseline.items.length} records` +
				(same ? " — identical to the unfiltered result, so the filter was dropped entirely" : "") +
				". A filter the backend does not understand must be rejected, never ignored: silently " +
				"ignoring it means every caller's filter may be doing nothing.",
			[baseline.exchange, result.exchange],
		)
	},
}

const equalityFilterSelectsOne: Check<{ id: string; field: string; term: Record<string, string> }> = {
	plan: (ctx) => {
		const target = ctx.records[0]
		if (!filterable(ctx) || !identityIsFilterable(ctx) || target === undefined) return cannot()
		const id = String(target[ctx.identity])
		const field = filterIdentity(ctx)
		const term = filterTerm(conv(ctx), field, "eq", id)
		return term === null
			? cannot("a filter grammar that can express equality on the identity")
			: ready({ field, id, term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write"],
	id: "filter.equality-selects-exactly-one",
	needs: "a `filter` parameter that accepts the identity field",
	subjects: subjectsOf.list,
	async run(ctx, { field, id, term }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		/* A rejected filter is not a wrong answer. If the backend says this field is not
		 * filterable, that is a capability statement — the gap belongs to x-query, which is
		 * already reported, not here. Reading a 4xx as "returned zero records" invents a defect. */
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the equality filter was rejected")
		const got = ids(result.items, ctx.identity)
		if (got.length === 1 && got[0] === id) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"equality filter on the identity does not select exactly one record",
			`filter=${field}.eq.${id} returned ${got.length} records (${got.slice(0, 5).join(", ")})`,
			[result.exchange],
		)
	},
}

const zeroMatchFilter: Check<{ term: Record<string, string> }> = {
	plan: (ctx) => {
		if (!filterable(ctx) || !identityIsFilterable(ctx)) return cannot()
		const missing = absentId(ctx)
		if (missing === null) return cannot(NO_ABSENT_ID)
		const term = filterTerm(conv(ctx), filterIdentity(ctx), "eq", missing)
		return term === null ? cannot("a filter grammar that can express equality on the identity") : ready({ term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write"],
	id: "filter.zero-match-returns-none",
	needs: "a `filter` parameter that accepts the identity field",
	subjects: subjectsOf.list,
	async run(ctx, { term }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the zero-match filter was rejected")
		if (result.items.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"filter that cannot match returns records anyway",
			`a filter on a value no record holds returned ${result.items.length} records, so the ` +
				"predicate is not being applied",
			[result.exchange],
		)
	},
}

const negationPartitions: Check<{
	field: string
	value: string
	eqTerm: Record<string, string>
	neqTerm: Record<string, string>
}> = {
	plan: (ctx) => {
		if (!filterable(ctx) || ctx.records.length <= 1 || !identityIsFilterable(ctx)) return cannot()
		/* Prefer a field with nulls in the cohort: partitioning on the identity can never expose
		 * three-valued-logic bugs, because an identity is never null. */
		const field = nullableField(ctx, filterableNames(ctx)) ?? filterIdentity(ctx)
		const probe = ctx.records.map((r) => r[field]).find((v) => v !== null && v !== undefined)
		if (probe === undefined) return cannot(`a cohort record with a non-null "${field}" to negate`)
		const value = String(probe)
		const eqTerm = filterTerm(conv(ctx), field, "eq", value)
		const neqTerm = filterTerm(conv(ctx), field, "neq", value)
		/* Negation has no representation in an equality-only grammar, so this property simply
		 * cannot be expressed against such an API — better to stand down than to send something
		 * meaningless and read the answer as a defect. */
		if (eqTerm === null || neqTerm === null) return cannot("a filter grammar that can express negation")
		return ready({ eqTerm, field, neqTerm, value })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		/* Partitioning is asserted over field *values*. A backend that drops submitted fields
		 * leaves the cohort without the value the predicate is built from. */
		"create.persists-submitted-fields",
		/* The three sets are gathered across pages, so a walk that skips or repeats records makes
		 * the partition fail for a reason that has nothing to do with the predicate. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.negation-partitions-the-set",
	needs: "a `filter` parameter supporting eq and neq",
	subjects: subjectsOf.list,
	async run(ctx, { eqTerm, field, neqTerm }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await collectSet(ctx, limit)
		const matching = await collectSet(ctx, limit, eqTerm)
		const complement = await collectSet(ctx, limit, neqTerm)
		if (all === null || matching === null || complement === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the partition was rejected",
			)
		}
		/* Set algebra only holds over complete sets. A walk that hit the page cap has seen a
		 * prefix, and the union would legitimately miss whatever lies beyond it. */
		if (!all.complete || !matching.complete || !complement.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be compared " + "against the whole set",
			)
		}

		const union = new Set([...ids(matching.items, ctx.identity), ...ids(complement.items, ctx.identity)])
		const expected = new Set(ids(all.items, ctx.identity))
		const overlap = ids(matching.items, ctx.identity).filter((value) =>
			ids(complement.items, ctx.identity).includes(value),
		)

		if (overlap.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a predicate and its negation both match the same record",
				`${overlap.length} record(s) appear in both ${field}.eq and ${field}.neq results: ` +
					overlap.slice(0, 3).join(", "),
				[matching.last.exchange, complement.last.exchange],
			)
		}
		const missing = [...expected].filter((id) => !union.has(id))
		if (missing.length > 0) {
			const nulls = missing.filter((id) => {
				const record = ctx.records.find((r) => String(r[ctx.identity]) === id)
				return record !== undefined && (record[field] === null || record[field] === undefined)
			})
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a predicate and its negation do not cover the full set",
				`${missing.length} record(s) match neither ${field}.eq nor ${field}.neq: ` +
					`${missing.slice(0, 3).join(", ")}. ` +
					(nulls.length === missing.length
						? `Every one of them has ${field} = null, so the negated predicate is dropping ` +
							"nulls — SQL evaluates `col <> x` as NULL, not true, unless the query also " +
							"tests `col IS NULL`."
						: "A record must satisfy either a predicate or its negation."),
				[all.last.exchange, matching.last.exchange, complement.last.exchange],
			)
		}
		return ASSERTED
	},
}

/**
 * Every filter check above uses a single predicate. Real filters compose them: `and(a,b)`,
 * `or(a,b)`, and nested combinations of both. This is the first of two checks giving that
 * combinator its own set-algebra property, needing no ground truth just like the rest: a
 * conjunction of two predicates must select exactly the intersection of what each selects alone.
 */
const filterAndComposesAsIntersection: Check<Compound> = {
	plan: (ctx) => (filterable(ctx) && (ctx.query?.filterable.length ?? 0) > 1 ? compoundPlan(ctx, andTerm) : cannot()),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		/* Both sides are gathered across pages, so a walk that skips or repeats records changes
		 * the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.and-composes-as-intersection",
	needs: "two filterable fields and a filter parameter or grammar supporting eq",
	subjects: subjectsOf.list,
	async run(ctx, { combined, fieldA, fieldB, termA, termB, valueA, valueB }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const both = await collectSet(ctx, limit, combined)
		if (onlyA === null || onlyB === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the intersection was rejected",
			)
		}
		if (!onlyA.complete || !onlyB.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the intersection cannot be verified",
			)
		}

		const setA = new Set(ids(onlyA.items, ctx.identity))
		const setB = new Set(ids(onlyB.items, ctx.identity))
		const expected = new Set([...setA].filter((id) => setB.has(id)))
		const got = new Set(ids(both.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extra = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and() does not compose as the intersection of its terms",
			`and(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose intersection is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but should not match both terms: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A conjunction must select exactly the records both terms match individually.",
			[onlyA.last.exchange, onlyB.last.exchange, both.last.exchange],
		)
	},
}

/**
 * The disjunction counterpart of {@link filterAndComposesAsIntersection}: `or(a,b)` must select
 * exactly the union of what each predicate selects alone. Only the postgrest-shaped grammar has
 * an `or()` combinator at all — per-field equality and the colon grammar's comma join are both
 * AND-only — so this stands down everywhere else rather than inventing a request to send.
 */
const filterOrComposesAsUnion: Check<Compound> = {
	plan: (ctx) =>
		conv(ctx).grammar === "postgrest" && (ctx.query?.filterable.length ?? 0) > 1 ? compoundPlan(ctx, orTerm) : cannot(),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"pagination.page-walk-covers-set",
		/* Deliberately does *not* depend on filter.and-composes-as-intersection: and() and or()
		 * being broken by the same defect is two independent manifestations of one root cause, not
		 * one causing the other. A defect that swaps the combinators corrupts both requests, and
		 * suppressing this as and()'s cascade would hide the half of the bug this check is the
		 * only thing that can see. */
	],
	id: "filter.or-composes-as-union",
	needs: "two filterable fields and an or() combinator (postgrest-shaped filter grammar)",
	subjects: subjectsOf.list,
	async run(ctx, { combined, fieldA, fieldB, termA, termB, valueA, valueB }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const either = await collectSet(ctx, limit, combined)
		if (onlyA === null || onlyB === null || either === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the union was rejected",
			)
		}
		if (!onlyA.complete || !onlyB.complete || !either.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be verified",
			)
		}

		const setA = new Set(ids(onlyA.items, ctx.identity))
		const setB = new Set(ids(onlyB.items, ctx.identity))
		const expected = new Set([...setA, ...setB])
		const got = new Set(ids(either.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extra = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"or() does not compose as the union of its terms",
			`or(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose union is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but matches neither term individually: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A disjunction must select exactly the records either term matches alone.",
			[onlyA.last.exchange, onlyB.last.exchange, either.last.exchange],
		)
	},
}

const sortReverseSymmetry: Check<{ field: string }> = {
	plan: (ctx) => {
		if (ctx.records.length <= 1) return cannot()
		/* A nullable sort key exercises null ordering, where the interesting bugs live. */
		const field =
			nullableField(ctx, ctx.query?.sortable ?? []) ??
			ctx.query?.sortable.find((f) => f !== ctx.identity) ??
			ctx.query?.sortable[0]
		return field === undefined ? cannot() : ready({ field })
	},
	/* The property is asserted over a *nullable* sort key, because that is where null-ordering
	 * bugs live. A backend that drops submitted fields leaves that column uniformly null, and a
	 * sort over one repeated value is symmetric no matter how badly the backend sorts. */
	dependsOn: [
		"create.persists-submitted-fields",
		/* Reversing an order that is never applied returns the same page twice. Every sort
		 * property is untestable until ordering itself is known to work. */
		"sort.order-is-applied",
		/* Both directions are gathered across pages, so a walk that skips or repeats records
		 * changes the membership this check compares — for reasons that are not about sorting. */
		"pagination.page-walk-covers-set",
	],
	id: "sort.reverse-symmetry",
	needs: "an `order` parameter supporting asc and desc",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		const limit = pageSize(ctx)
		/* Gathered across pages: a collection larger than one page would otherwise leave this
		 * property — that a reversal reorders a set without changing its membership — untested on
		 * exactly the collections where sorting matters most. */
		const ascending = await collectSet(ctx, limit, {}, sortTerm(conv(ctx), field, "asc"))
		const descending = await collectSet(ctx, limit, {}, sortTerm(conv(ctx), field, "desc"))
		if (ascending === null || descending === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`ordering by "${field}" was rejected in one direction, so the two cannot be compared`,
			)
		}

		/* Only comparable when a single page holds the whole collection. Otherwise asc and desc
		 * return opposite *windows* of it — legitimately different sets, and comparing them would
		 * report every capped collection as broken. */
		if (!ascending.complete || !descending.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two directions return " +
					"different windows of it rather than the same set reversed",
			)
		}

		const forward = ids(ascending.items, ctx.identity)
		const backward = ids(descending.items, ctx.identity)
		if (forward.length !== backward.length) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"ascending and descending sorts return different numbers of records",
				`order=${field}.asc returned ${forward.length}, order=${field}.desc returned ${backward.length}`,
				[ascending.last.exchange, descending.last.exchange],
			)
		}
		if (forward.join(",") === [...backward].reverse().join(",")) return ASSERTED

		/* Values may legitimately tie; only flag when the multisets differ or a strict field
		 * ordering is violated, not when equal keys land in a different arrangement. */
		const sameSet = [...forward].sort().join(",") === [...backward].sort().join(",")
		if (!sameSet) {
			const onlyAsc = forward.filter((id) => !backward.includes(id))
			const onlyDesc = backward.filter((id) => !forward.includes(id))
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"ascending and descending sorts return different sets",
				`order=${field}.asc and order=${field}.desc disagree about which records exist. ` +
					`Only ascending: ${onlyAsc.slice(0, 3).join(", ") || "—"}. ` +
					`Only descending: ${onlyDesc.slice(0, 3).join(", ") || "—"}. ` +
					"Sort direction must reorder a collection, never change its membership.",
				[ascending.last.exchange, descending.last.exchange],
			)
			return ASSERTED
		}
		/* Up to ties, descending is ascending reversed — whatever the collation, since both come
		 * from the same backend. Compared by value, so tied records may land in any arrangement;
		 * nulls are left out, as either end is a legitimate place for them in either direction. */
		const present = (items: Record_[]): string[] =>
			items
				.map((item) => item[field])
				.filter((value) => value !== null && value !== undefined)
				.map((value) => JSON.stringify(value))
		const up = present(ascending.items)
		const down = present(descending.items)
		if (up.join("\u0000") === [...down].reverse().join("\u0000")) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"descending order is not ascending order reversed",
			`order=${field}.asc gives ${up.slice(0, 4).join(", ")}…, but order=${field}.desc reversed gives ` +
				`${[...down].reverse().slice(0, 4).join(", ")}…. One direction applies a different ordering than the other.`,
			[ascending.last.exchange, descending.last.exchange],
		)
	},
}

const pageWalkCoversSet: Check = {
	/* Walked by whatever the endpoint pages by — a cursor alone is enough. */
	plan: (ctx) => when((pageable(ctx) || conv(ctx).cursor !== undefined) && ctx.records.length > 2),
	dependsOn: [
		"list.read-after-write",
		"pagination.limit-bounds-page-size",
		"pagination.has-more-is-accurate",
		/* A page walk is only sound over a total order. Where the requested order is discarded,
		 * the pages are windows onto an arbitrary sequence, and any drift they show is the
		 * missing sort rather than a pagination defect. */
		"sort.order-is-applied",
	],
	id: "pagination.page-walk-covers-set",
	needs: "a way to page forward — a page number, a row offset or a cursor — and at least three records",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const limit = pageSize(ctx)
		/* Walk under a low-cardinality sort. Distinct keys admit exactly one valid order, so an
		 * unstable sort is indistinguishable from a correct one until values tie. */
		const order = tiedSortField(ctx)
		const orderParam = order === null ? undefined : sortTerm(conv(ctx), order, "asc")
		/* The whole set, read at the largest page: what a walk at two per page must reproduce. */
		void limit
		const whole = await readSet(ctx, {}, { order: orderParam })
		const single = whole.last
		const expected = ids(whole.items, ctx.identity)
		/* Two per page, so every record sits near a page boundary — unless the collection is too
		 * large to walk that way within the page cap, when pages grow just enough to reach its end.
		 * A walk cut short proves nothing about what it never reached. */
		const walkSize = Math.min(limit, Math.max(2, Math.ceil(expected.length / (MAX_WALK_PAGES - 1))))
		const walk = await walkPages(ctx, walkSize, orderParam)
		const walked = walk.ids

		const repeated = duplicates(walked)
		if (repeated.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"paging returns the same record on more than one page",
				`walking at limit=${walkSize} returned ${repeated.length} duplicated id(s): ${repeated.slice(0, 3).join(", ")}. ` +
					"This is the signature of a sort without a total order — the page boundary is not stable.",
				[single.exchange],
			)
		}
		/* A capped walk saw only a prefix of the collection, so "missing" would just mean "beyond
		 * the cap". Duplicates above are still meaningful; absence is not. */
		const missing = walk.truncated || !whole.complete ? [] : expected.filter((id) => !walked.includes(id))
		if (missing.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"paging skips records that a single large page returns",
				`a single page at limit=${limit} returned ${expected.length} records, but walking at ` +
					`limit=${walkSize} yielded ${walked.length} and missed ${missing.length}: ${missing.slice(0, 3).join(", ")}`,
				[single.exchange],
			)
		}

		/* Instability is probabilistic: one walk can come out intact by luck. Two identical walks
		 * must agree, so comparing them tests the ordering guarantee directly rather than waiting
		 * for a dropped row to happen to appear. */
		const second = (await walkPages(ctx, walkSize, orderParam)).ids
		if (second.join(",") === walked.join(",")) return ASSERTED
		const sameSet = [...second].sort().join(",") === [...walked].sort().join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			sameSet
				? "identical page walks return records in different orders"
				: "identical page walks return different records",
			`walking the collection twice with the same parameters` +
				(orderParam === undefined ? "" : ` (order=${orderParam})`) +
				` produced ${sameSet ? "the same records in a different order" : "different sets"}. ` +
				"Pagination requires a total order; without a tiebreak the page boundary moves between " +
				"requests and callers silently miss or repeat rows.",
			[single.exchange],
		)
	},
}

const cursorAgreesWithPage: Check = {
	plan: (ctx) => when(conv(ctx).cursor !== undefined && pageable(ctx) && ctx.records.length > 2),
	dependsOn: [
		"pagination.page-walk-covers-set",
		/* Sorting by a field whose value never persisted is degenerate, so a pagination
		 * disagreement there describes a consequence rather than a pagination defect. */
		"create.persists-submitted-fields",
		/* Both walks are taken at a requested page size. If the backend serves a different size
		 * than asked for, the two walks step differently and disagree for that reason alone. */
		"pagination.limit-respects-documented-max",
	],
	id: "pagination.cursor-agrees-with-page",
	needs: "both `cursor` and `page` parameters",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		/* Walk under an explicit text sort. Cursor pagination is almost always used with one, and
		 * a boundary resolved under a different collation than the listing can only diverge when
		 * the ordering key is text. */
		const sortField =
			ctx.query?.sortable.find((f) => {
				if (f === ctx.identity) return false
				return ctx.records.some((r) => typeof r[f] === "string" && r[f] !== "")
			}) ?? undefined
		const order = sortField === undefined ? undefined : sortTerm(conv(ctx), sortField, "asc")

		const pageWalk = await walkPages(ctx, 2, order)
		const cursorWalk = await walkCursor(ctx, 2, order)
		const byPage = pageWalk.ids
		const byCursor = cursorWalk.ids

		/* Repeats are their own defect: a cursor that resolves to the wrong boundary re-serves the
		 * previous page's tail, which set comparison alone would hide. */
		const repeated = duplicates(byCursor).filter((id) => !duplicates(byPage).includes(id))
		if (repeated.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"cursor pagination re-serves records the previous page already returned",
				`walking by cursor returned ${repeated.length} record(s) more than once ` +
					`(${repeated.slice(0, 3).join(", ")}) while the offset walk returned each exactly once. ` +
					"The cursor is resolving to the wrong boundary.",
				/* The cursor pages up to the one that served a record again. */
				cursorWalk.exchanges.slice(
					0,
					Math.max(
						2,
						1 +
							cursorWalk.exchanges.findLastIndex((exchange) =>
								extractItems(exchange.responseBody, ctx.collectionKey).some((item) =>
									repeated.includes(String(item[ctx.identity])),
								),
							),
					),
				),
			)
		}

		/*
		 * Two walks capped at the same number of equal pages cover the same prefix of one order,
		 * so their prefixes compare — except across a tie at the cut, where either of the tied
		 * records may legitimately fall inside. Those are left out. With no explicit order there
		 * is no prefix to speak of, and a capped walk proves nothing.
		 */
		let pageItems = pageWalk.items
		let cursorItems = cursorWalk.items
		if (pageWalk.truncated || cursorWalk.truncated) {
			if (sortField === undefined) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "a walk was cut short, so the two cannot be compared")
			}
			const length = Math.min(pageItems.length, cursorItems.length)
			const atCut = JSON.stringify(pageItems[length - 1]?.[sortField])
			const clear = (items: Record_[]): Record_[] =>
				items.slice(0, length).filter((item) => JSON.stringify(item[sortField]) !== atCut)
			pageItems = clear(pageItems)
			cursorItems = clear(cursorItems)
		}

		const pageSet = [...new Set(ids(pageItems, ctx.identity))].sort()
		const cursorSet = [...new Set(ids(cursorItems, ctx.identity))].sort()
		if (pageSet.join(",") === cursorSet.join(",")) return ASSERTED

		const onlyPage = pageSet.filter((id) => !cursorSet.includes(id))
		const onlyCursor = cursorSet.filter((id) => !pageSet.includes(id))
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"cursor pagination and offset pagination disagree",
			`offset walk yielded ${pageSet.length} distinct records, cursor walk yielded ${cursorSet.length}. ` +
				`Only in offset: ${onlyPage.slice(0, 3).join(", ") || "—"}. ` +
				`Only in cursor: ${onlyCursor.slice(0, 3).join(", ") || "—"}. ` +
				"Both traverse the same collection, so one of them is losing or repeating rows.",
			[...pageWalk.exchanges.slice(0, 2), ...cursorWalk.exchanges.slice(0, 2)],
		)
	},
}

/**
 * The reported total must be consistent with the page it accompanies.
 *
 * A count that reads zero beside a non-empty payload is not a rounding difference — it is a
 * separate query answering a different question, and every UI that renders "N results" from it
 * shows a number contradicted by the rows directly beneath.
 */
const countIsConsistentWithPage: Check = {
	plan: (ctx) => when(ctx.records.length > 0),
	dependsOn: ["list.read-after-write"],
	id: "count.consistent-with-returned-page",
	needs: "a total-count field in the list envelope",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing was rejected")
		const reported = envelopeValue(ctx, result, "total")
		if (typeof reported !== "number") return standDown("the listing reports no total")
		const returned = result.items.length
		if (returned === 0) return ctx.findings.unresolved(this.id, ctx.entityName, "the listing returned nothing to count")
		if (reported >= returned) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"reported count is smaller than the number of records returned",
			`the response carries count=${reported} while returning ${returned} record(s) in the same ` +
				`body${envelopeValue(ctx, result, "hasMore") === true ? " and hasMore=true" : ""}. The total is being ` +
				"computed by a query that disagrees with the one producing the rows, so any caller " +
				"rendering a result count contradicts the list it is labelling.",
			[result.exchange],
		)
	},
}

const countMatchesWalk: Check<{ countTerm: Record<string, string> }> = {
	plan: (ctx) => {
		if (ctx.records.length <= 1 || !filterable(ctx) || !identityIsFilterable(ctx)) return cannot()
		const target = ctx.records[0]
		const countTerm =
			target === undefined ? null : filterTerm(conv(ctx), filterIdentity(ctx), "eq", String(target[ctx.identity]))
		return countTerm === null
			? cannot("a filter grammar that can express equality on the identity")
			: ready({ countTerm })
	},
	/* Compares the reported total against the *filtered* set. Where the filter is ignored the two
	 * agree trivially — both describe the whole collection — so the count cannot be judged until
	 * filtering itself is known to work. */
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write", "filter.equality-selects-exactly-one"],
	id: "count.matches-filtered-set",
	needs: "a total-count field and a `filter` parameter",
	subjects: subjectsOf.list,
	async run(ctx, { countTerm }): Promise<Outcome> {
		const filtered = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...countTerm })
		if (filtered.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered listing was rejected")
		const reported = envelopeValue(ctx, filtered, "total")
		if (typeof reported !== "number") return standDown("the listing reports no total")
		if (reported === filtered.items.length) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"reported count disagrees with the filtered result",
			`filter selected ${filtered.items.length} record(s) but count reported ${reported}. ` +
				"A count that ignores the active filter makes every paginated UI show wrong totals.",
			[filtered.exchange],
		)
	},
}

const selectProjection: Check<{ requested: string[]; projection: Record<string, string> }> = {
	plan: (ctx) => {
		if (conv(ctx).select === undefined || ctx.records.length === 0) return cannot()
		const requested = [ctx.identity]
		const extra = ctx.query?.selectable.find((f) => f !== ctx.identity)
		if (extra !== undefined) requested.push(extra)
		/* Through the grammar, not the bare parameter: JSON:API carries the resource type in the
		 * parameter *name*, so `select=` never reaches a backend expecting `fields[table]=`. */
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ projection, requested })
	},
	id: "select.projection-honoured",
	needs: "a `select` sparse-fieldset parameter",
	subjects: subjectsOf.list,
	async run(ctx, { projection, requested }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items.length === 0)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the projected listing was rejected or empty")
		const first = result.items[0]
		if (first === undefined) return ctx.findings.unresolved(this.id, ctx.entityName, "the projected listing was empty")
		const returned = Object.keys(first)
		const unexpected = returned.filter((key) => !requested.includes(key))
		if (unexpected.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"sparse fieldset is accepted but ignored",
			`select=${requested.join(",")} returned ${returned.length} fields, including ` +
				`${unexpected.slice(0, 5).join(", ")}. Accepting a projection and ignoring it silently ` +
				"inflates every response and leaks fields a caller deliberately excluded.",
			[result.exchange],
		)
	},
}

const patchMinimality: Check<{ updateOp: OperationModel; readOp: OperationModel }> = {
	plan: (ctx) => {
		const { updateOp, readOp } = ctx
		if (updateOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		/* Partial update is what PATCH promises; a PUT replaces the record by definition. */
		if (updateOp.method.toUpperCase() !== "PATCH") return cannot("an update by PATCH, which promises a partial write")
		return ready({ readOp, updateOp })
	},
	mutates: true,
	id: "patch.minimality",
	needs: "a create, a PATCH update and an item route",
	subjects: subjectsOf.update,
	async run(ctx, { readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const id = made.scratch.id
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const before = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		if (before.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back returned ${before.status}, so no baseline could be established`,
			)
		}
		const original = (before.responseBody ?? {}) as Record_

		/* A control record, never written to, observed across the same window as the target.
		 * Real APIs expose server-driven fields — job progress, computed counts, expiry clocks —
		 * and repeated sampling cannot distinguish those from a write side effect once they
		 * settle. A field that moves on the control moved on its own. */
		const control = ctx.records.find((r) => String(r[ctx.identity]) !== id)
		const controlParams =
			control === undefined ? undefined : { ...ctx.scope, ...itemParamFor(ctx, String(control[ctx.identity])) }
		const controlBefore =
			controlParams === undefined
				? undefined
				: await ctx.client.get(fillPath(readOp.path, controlParams), { headers: ctx.auth() })

		const settle = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		/*
		 * Fields that may move without this PATCH having moved them.
		 *
		 * Timestamps by name, and — more importantly — anything the document declares
		 * server-generated. A generated field is by definition not the caller's to set, so finding
		 * it changed proves nothing about whether PATCH behaved as PUT. Some are derived from
		 * *other* entities entirely (a row count on its parent table), and since entities are
		 * tested concurrently such a field can change mid-check for reasons that have nothing to
		 * do with this request. The control record catches drift the whole collection shares, but
		 * not drift confined to the one record under test.
		 */
		const drifting = new Set<string>([
			"updated_at",
			"modified_at",
			/* A job's progress counter advances on GET without this PATCH having written it. */
			"progress",
			/*
			 * From both operations, not just the one being probed. A document commonly declares
			 * its server-owned fields on `create` — that is where they are conspicuous, being the
			 * fields a caller may not supply — and omits the same list on `update`. Reading only
			 * the update operation meant a field the document plainly called generated was still
			 * compared, and a progress counter advancing on its own read as a PATCH side effect.
			 */
			...(ctx.createOp?.generated ?? []),
			...(updateOp.generated ?? []),
		])
		if (settle.status < 300) {
			const second = (settle.responseBody ?? {}) as Record_
			for (const key of Object.keys(original)) {
				if (JSON.stringify(original[key]) !== JSON.stringify(second[key])) drifting.add(key)
			}
		}

		const field = pickWritableStringField(ctx, original)
		if (field === null) return standDown("no field can be patched on its own")
		const next = changedValue(ctx, field, original[field], updateOp)
		if (next === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no other valid value for "${field}" can be made`)
		}

		const patched = await ctx.client.request("PATCH", fillPath(updateOp.path, params), {
			body: { [field]: next },
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, updateOp, patched, this.id))
			return standDown("a documented feature gate refused the request")
		if (patched.status >= 300) return ctx.findings.unresolved(this.id, ctx.entityName, "the patch was refused")

		const after = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		const current = (after.responseBody ?? {}) as Record_

		const baseline = (settle.status < 300 ? settle.responseBody : before.responseBody) as Record_
		let collateral = Object.keys(original).filter((key) => {
			if (key === field || drifting.has(key)) return false
			return JSON.stringify(baseline[key]) !== JSON.stringify(current[key])
		})
		if (collateral.length === 0) return ASSERTED

		/* Whatever also moved on the untouched control record was not caused by this PATCH. */
		if (controlParams !== undefined && controlBefore !== undefined && controlBefore.status < 300) {
			const controlAfter = await ctx.client.get(fillPath(readOp.path, controlParams), {
				headers: ctx.auth(),
			})
			if (controlAfter.status < 300) {
				const from = (controlBefore.responseBody ?? {}) as Record_
				const to = (controlAfter.responseBody ?? {}) as Record_
				collateral = collateral.filter((key) => JSON.stringify(from[key]) === JSON.stringify(to[key]))
			}
		}
		if (collateral.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"PATCH changed fields the request did not mention",
			`patching only "${field}" also changed ${collateral.length} other field(s): ` +
				collateral
					.slice(0, 5)
					.map((key) => `${key} ${JSON.stringify(baseline[key])} → ${JSON.stringify(current[key])}`)
					.join("; ") +
				". PATCH is a partial update; behaving as PUT silently destroys data callers never sent.",
			[before, patched, after],
		)
	},
}

function pickWritableStringField(ctx: CheckContext, record: Record_): string | null {
	const immutable = new Set([...(ctx.updateOp?.immutable ?? []), ...(ctx.updateOp?.generated ?? [])])
	for (const [key, value] of Object.entries(record)) {
		if (immutable.has(key) || key === ctx.identity) continue
		if (/_at$|_id$/.test(key)) continue
		if (typeof value === "string" && value !== "") return key
	}
	return null
}

const immutableRejected: Check<{ field: string; updateOp: OperationModel; readOp: OperationModel }> = {
	plan: (ctx) => {
		const { updateOp, readOp } = ctx
		if (updateOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		const field = updateOp.immutable.find((f) => f !== ctx.identity) ?? updateOp.immutable[0]
		return field === undefined ? cannot() : ready({ field, readOp, updateOp })
	},
	mutates: true,
	id: "patch.immutable-field-rejected",
	needs: "fields declared immutable via x-immutable",
	subjects: subjectsOf.update,
	async run(ctx, { field, readOp, updateOp }): Promise<Outcome> {
		/* Its own record: an immutable field is very often the tenant or parent key, and a backend
		 * that accepts the write moves the record out of the scope every later check reads. */
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const { id, record: target } = made.scratch
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const probe = changedValue(ctx, field, target[field])
		if (probe === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no other valid value for "${field}" can be made`)
		}
		const update = await updateRequest(ctx, updateOp, target, { [field]: probe })
		const patched = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
			...update.options,
			headers: ctx.auth(),
			operationId: updateOp.operationId,
		})
		if (standDownForFeatureGate(ctx, updateOp, patched, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation", "conflict"], patched)
		if (refused !== null) return refused

		/* Read the echoed record first. Re-reading can itself fail once the write lands — writing
		 * a tenant key, for instance, moves the record out of the caller's scope — and that
		 * failure would otherwise mask the very defect being probed. */
		const echoed = (patched.responseBody ?? {}) as Record_
		const after = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		const current = (after.responseBody ?? {}) as Record_
		const accepted = echoed[field] === probe || current[field] === probe
		if (!accepted) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a field declared immutable accepted a write",
			`${update.method} set "${field}" to a client-supplied value and the change persisted. ` +
				"Server-owned fields must reject writes, not absorb them.",
			[patched, after],
		)
	},
}

const likeEscaping: Check<{ field: string; likeTerm: Record<string, string> }> = {
	plan: (ctx) => {
		if (!filterable(ctx) || ctx.records.length <= 1) return cannot()
		const field = firstFilterable(ctx, (name) => (ctx.query?.searchable ?? []).includes(name))
		if (field === null) return cannot("a field that is both filterable and searchable")
		/* A literal `%` is not a wildcard in this grammar — `*` is. Matching everything means the
		 * value was interpolated into a LIKE pattern unescaped. */
		const likeTerm = filterTerm(conv(ctx), field, "like", "%")
		return likeTerm === null ? cannot("a filter grammar with a like operator") : ready({ field, likeTerm })
	},
	/* The tell is "the filtered result equals the whole listing". Where the listing is already
	 * wrong, that comparison is against a set the backend never served correctly. */
	dependsOn: ["query.filter-selects-from-whole-set", "pagination.page-walk-covers-set", "list.read-after-write"],
	id: "filter.like-metacharacters-escaped",
	needs: "a `filter` parameter supporting a like operator",
	subjects: subjectsOf.list,
	async run(ctx, { field, likeTerm }): Promise<Outcome> {
		const total = await readSet(ctx)
		const probe = await readSet(ctx, likeTerm)
		if (probe.status !== "ok") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the like probe was rejected with ${probe.last.exchange.status}, so escaping was never exercised`,
			)
		}
		if (total.status !== "ok" || !total.complete || !probe.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (total.items.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the unfiltered listing returned nothing, leaving no baseline to compare the probe against",
			)
		}
		if (probe.items.length < total.items.length) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"LIKE metacharacters in a filter value are not escaped",
			`filter=${field}.like.%25 matched all ${probe.items.length} records. "%" is a literal in ` +
				"this grammar; treating it as a wildcard means user input is being interpolated into a " +
				"pattern unescaped.",
			[total.last.exchange, probe.last.exchange],
		)
	},
}

const createStatusMatchesSpec: Check<{ createOp: OperationModel; success: string[] }> = {
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined) return cannot()
		const success = describeSuccess(createOp.statuses)
		return success.length === 0 ? cannot("a success status documented for create") : ready({ createOp, success })
	},
	id: "create.status-matches-document",
	judgesTranscript: true,
	needs: "a create operation",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, success }): Promise<Outcome> {
		const exchange = await createExchange(ctx)
		if (exchange === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no successful create of this entity was observed")
		if (documentsStatus(createOp.statuses, exchange.status)) return ASSERTED
		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"create returns a success status the document does not declare",
			`${createOp.operationId} returned ${exchange.status}; the document declares ` +
				`${success.join(", ")}. Either the handler or the document is wrong, and clients ` +
				"generated from the spec will not recognise the response.",
			[exchange],
		)
	},
}

/**
 * The successful create exchange for this entity, matched on the fully-resolved path.
 *
 * Prefix matching is not enough: two entities can share a prefix up to their first path
 * parameter (`/v1/projects/{project_id}/tables` and `.../tables/{table_id}/rows` both truncate
 * to `/v1/projects/`), which silently pairs one entity's response with another's schema.
 */
async function createExchange(ctx: CheckContext): Promise<Exchange | undefined> {
	const createOp = ctx.createOp
	if (createOp === undefined) return undefined
	let resolved: string
	try {
		resolved = fillPath(createOp.path, ctx.scope)
	} catch {
		return undefined
	}
	/* By operation, then by the resolved path below the base URL: a pathname comparison misses
	 * every exchange once the API is mounted under a prefix. */
	const found = ctx.client
		.exchangesFor(createOp.operationId)
		.find((e) => e.status < 300 && ctx.client.relativePath(e.url) === resolved)
	return found === undefined ? undefined : ctx.client.hydrate(found)
}

const deleteMissingIs404: Check<{ deleteOp: OperationModel; missing: string }> = {
	plan: (ctx) => {
		if (ctx.deleteOp === undefined) return cannot()
		const missing = absentId(ctx)
		return missing === null ? cannot(NO_ABSENT_ID) : ready({ deleteOp: ctx.deleteOp, missing })
	},
	mutates: true,
	id: "delete.absent-record-returns-404",
	needs: "a delete operation",
	subjects: subjectsOf.delete,
	async run(ctx, { deleteOp, missing }): Promise<Outcome> {
		const params = { ...ctx.scope, ...itemParamFor(ctx, missing) }
		const exchange = await asProbe(ctx).client.request("DELETE", fillPath(deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, deleteOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		if (exchange.status === 404 || exchange.status === 410 || exchange.status === 400) return ASSERTED
		if (exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"deleting a nonexistent record crashes",
				`DELETE of an id that was never created returned ${exchange.status}; it should be 404.`,
				[exchange],
			)
		}
		if (exchange.status >= 300)
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"deleting an absent record was refused for another reason",
			)
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"deleting a nonexistent record reports success",
			`DELETE of an id that was never created returned ${exchange.status}. Callers cannot ` +
				"distinguish a real deletion from a no-op, which hides broken client state.",
			[exchange],
		)
	},
}

const softDeleteHidden: Check<{ deleteOp: OperationModel }> = {
	plan: (ctx) => {
		if (ctx.deleteOp === undefined || ctx.softDelete === null || ctx.createOp === undefined) return cannot()
		return ready({ deleteOp: ctx.deleteOp })
	},
	mutates: true,
	/* The evidence for a tombstone leak is the record still being *in the listing*. On a backend
	 * whose listing already omits records it should contain, "absent" proves nothing. */
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write"],
	id: "softdelete.absent-from-default-list",
	needs: "a create, a delete operation and x-soft-delete",
	subjects: subjectsOf.deleteAndList,
	async run(ctx, { deleteOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const id = made.scratch.id
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const deleted = await ctx.client.request("DELETE", fillPath(deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, deleteOp, deleted, this.id))
			return standDown("a documented feature gate refused the request")
		if (deleted.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`DELETE returned ${deleted.status}, so no tombstone was created to look for`,
			)
		}

		/* Absence is only proven over the whole listing: a tombstone on page three is still there. */
		const after = await readSet(ctx, {}, { fresh: true })
		if (after.status !== "ok") {
			return ctx.findings.unresolved(this.id, ctx.entityName, after.reason ?? "the listing was rejected")
		}
		if (!ids(after.items, ctx.identity).includes(id)) {
			if (after.complete) return ASSERTED
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing is larger than a read covers")
		}
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"soft-deleted record still appears in the default listing",
			`${ctx.entityName} ${id} was deleted (tombstoned via "${ctx.softDelete}") but the default ` +
				"list still returns it. Tombstones must be excluded unless explicitly requested.",
			[deleted, after.last.exchange],
		)
	},
}

/**
 * A denial must not reveal whether the record exists.
 *
 * Refusing a cross-tenant read is correct. Refusing it with a *different status* than an id that
 * was never issued is an oracle: an attacker walks the identifier space and reads existence off
 * the status code, learning how many records another tenant holds and which ids are live — all
 * without ever being served a body. The access decision looks right in every log.
 *
 * The comparison is what makes this decidable without knowing the backend's policy. Whichever
 * status it picks is fine; picking two different ones is not.
 */
const denialDoesNotRevealExistence: Check<{
	target: Record_
	readOp: OperationModel
	altAuth: () => Record<string, string>
}> = {
	plan: (ctx) => {
		const { altAuth, readOp } = ctx
		const target = ctx.records[0]
		if (altAuth === undefined || readOp === undefined || target === undefined || !tenantBoundary(readOp)) {
			return cannot()
		}
		return ready({ altAuth, readOp, target })
	},
	dependsOn: [
		/* If the record is readable across tenants at all, that is the finding — how the denial
		 * would have been phrased is beside the point. */
		"tenant.item-not-readable-cross-tenant",
	],
	id: "tenant.denial-does-not-reveal-existence",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.read,
	async run(ctx, { altAuth, readOp, target }): Promise<Outcome> {
		const realId = String(target[ctx.identity])
		/* Shaped like a real identifier so the difference under test is existence, not format —
		 * a backend may legitimately reject a malformed id differently. */
		const absentProbe = constructedAbsentId(ctx)
		if (absentProbe === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no well-formed identifier that names nothing can be built from the identifier schema",
			)
		}

		const ask = async (id: string): Promise<Exchange> =>
			asProbe(ctx).client.get(fillPath(readOp.path, { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }), {
				headers: altAuth(),
			})

		const existing = await ask(realId)
		const absent = await ask(absentProbe)

		/* Only a denial pair is meaningful. A 2xx on the existing record is a cross-tenant read,
		 * which the check above owns and this one is suppressed by. */
		if (existing.status < 400 || absent.status < 400) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the two probes was not denied, so there is no pair of denials to compare",
			)
		}
		if (existing.status === absent.status) return ASSERTED

		return ctx.findings.security(
			this.id,
			ctx.entityName,
			"the denial status reveals whether a record exists",
			`a record belonging to another tenant was refused with ${existing.status}, while an id ` +
				`that does not exist was refused with ${absent.status}. The difference is an oracle: ` +
				"anyone able to guess or enumerate identifiers can learn which ones are real without " +
				"ever reading one. Both cases must answer identically — conventionally 404.",
			[existing, absent],
		)
	},
}

/**
 * Replaying a create with the same idempotency key must not create a second record.
 *
 * An API that publishes the header has made a promise, and it is a promise clients rely on to
 * make retries safe: a timeout, a proxy replay or a double-click all resend the same request. If
 * the key is accepted and ignored, every one of those silently duplicates whatever the record
 * represents — a charge, an order, a transfer. Nothing about a single request reveals this;
 * it only shows up when the request is actually replayed.
 *
 * Both halves are asserted, because either alone is satisfiable by a broken backend: the replay
 * must return the *original* record, and the collection must not have grown.
 */
const idempotentReplay: Check<{ createOp: OperationModel; header: string; schema: Record<string, unknown> }> = {
	plan: (ctx) => {
		const createOp = ctx.createOp
		const header = createOp?.idempotencyHeader
		if (createOp === undefined || header == null) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		return schema === null
			? cannot("a create operation with a request body to replay")
			: ready({ createOp, header, schema })
	},
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write", "create.persists-submitted-fields"],
	id: "idempotency.replay-does-not-duplicate",
	mutates: true,
	needs: "a create operation declaring an idempotency-key header",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, header, schema }): Promise<Outcome> {
		const body = validBody(ctx, schema)
		/* The nonce keeps a second run from replaying the first run's request — and getting the
		 * first run's record back, which reads as a pass while proving nothing. */
		const key = `oat-idem-${ctx.nonce}-${ctx.entityName}`
		const path = fillPath(createOp.path, ctx.scope)
		const headers = { ...ctx.auth(), [header]: key }

		const encoded = await encodeOpBody(ctx, createOp, body)
		const first = await ctx.client.request("POST", path, { ...encoded, headers })
		if (standDownForFeatureGate(ctx, createOp, first, this.id))
			return standDown("a documented feature gate refused the request")
		if (first.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the first create returned ${first.status}, so there was nothing to replay`,
			)
		}
		const identityOf = (exchange: Exchange): string | undefined => {
			const value = ((exchange.responseBody ?? {}) as Record_)[ctx.identity]
			return typeof value === "string" || typeof value === "number" ? String(value) : undefined
		}
		const firstId = identityOf(first)
		if (firstId === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the create response carries no "${ctx.identity}", so a replay cannot be matched to it`,
			)
		}
		const before = await readSet(ctx, {}, { fresh: true })
		const second = await ctx.client.request("POST", path, { ...encoded, headers })
		if (standDownForFeatureGate(ctx, createOp, second, this.id))
			return standDown("a documented feature gate refused the request")
		if (second.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the replay returned ${second.status}; a repeated key must be answered, not refused`,
			)
		}

		const secondId = identityOf(second)
		if (secondId === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the replay's response carries no "${ctx.identity}", so it cannot be matched to the original`,
			)
		}
		if (firstId === secondId) {
			/* The other half: answering with the original record while still inserting a second. */
			const after = await readSet(ctx, {}, { fresh: true })
			if (before.status !== "ok" || after.status !== "ok" || !before.complete || !after.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"the collection could not be read whole around the replay, so growth was not ruled out",
				)
			}
			if (after.items.length <= before.items.length) return ASSERTED
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"replaying a request with the same idempotency key grew the collection",
				`the replay carrying ${header}: "${key}" answered with the original ${ctx.entityName} ${firstId}, ` +
					`yet the collection went from ${before.items.length} to ${after.items.length} records. The ` +
					"response hides a duplicate the retry still made.",
				[first, second, before.last.exchange, after.last.exchange],
			)
		}

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"replaying a request with the same idempotency key created a second record",
			`two identical POSTs carrying ${header}: "${key}" produced ${ctx.entityName} ${firstId} ` +
				`and ${secondId}. The header is declared, so clients will retry on timeouts assuming ` +
				"it protects them; every such retry silently duplicates the record.",
			[first, second],
		)
	},
}

/**
 * A route the document says a write invalidates must actually change.
 *
 * `x-invalidate` is the tag the whole entity graph is derived from, and until now it was believed
 * rather than tested: oat inverted the claim into a read surface and never asked whether the
 * claim was true. The interesting case is cross-entity — creating a child changes what the
 * *parent* route serves, via a denormalised counter or a cached projection. Those are the writes
 * that go wrong quietly: the write succeeds, the child's own listing is right, and only the other
 * route the document named is stale. Nothing but following the declaration finds it.
 *
 * Only routes belonging to a different entity are probed. This entity's own listing is already
 * covered by read-after-write, and re-asserting it here would report one defect twice.
 */
const declaredInvalidationHappens: Check<{
	createOp: OperationModel
	foreign: OperationModel[]
	schema: Record<string, unknown>
}> = {
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined) return cannot()
		/* A graded create is judged through every route it declares; a graded route alone is
		 * judged only itself, with the create as support. */
		const createGraded = graded(ctx, createOp)
		const foreign = createOp.invalidates
			.map((route) => ctx.model.byRoute.get(route))
			.filter(
				(op): op is OperationModel =>
					op !== undefined &&
					op.entity !== ctx.entityName &&
					op.method.toUpperCase() === "GET" &&
					(createGraded || graded(ctx, op)),
			)
		if (foreign.length === 0) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		return schema === null ? cannot("a create operation with a request body") : ready({ createOp, foreign, schema })
	},
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write", "create.persists-submitted-fields"],
	id: "invalidation.declared-route-changes",
	mutates: true,
	needs: "a create operation whose x-invalidate names another entity's read route",
	subjects: subjectsOf.createAndForeignReads,
	async run(ctx, { createOp, foreign, schema }): Promise<Outcome> {
		/* Only routes whose path can be filled from this entity's scope are probed: a route
		 * needing an identifier oat does not hold would 404 for a reason unrelated to staleness. */
		const probes: Array<{ op: OperationModel; path: string }> = []
		for (const op of foreign) {
			const path = fillPath(op.path, ctx.scope)
			if (path.includes("{")) continue
			probes.push({ op, path })
		}
		if (probes.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the declared routes need identifiers outside this entity's scope, so they cannot be read",
			)
		}

		/* What a route serves, as a comparable snapshot: a collection read whole, since the record
		 * the write changed may sit on any page of it. `undefined` when it cannot be read whole. */
		const snapshot = async (
			probe: (typeof probes)[number],
		): Promise<{ text: string; exchange: Exchange } | undefined> => {
			if (probe.op.collection !== null) {
				const read = await readSet(forList(ctx, probe.op), {}, { fresh: true })
				if (read.status !== "ok" || !read.complete) return undefined
				return { exchange: read.last.exchange, text: JSON.stringify(read.items) }
			}
			const exchange = await ctx.client.get(probe.path, { headers: ctx.auth() })
			return exchange.status >= 400 ? undefined : { exchange, text: JSON.stringify(exchange.responseBody) }
		}
		const before = new Map<string, string>()
		for (const probe of probes) {
			const taken = await snapshot(probe)
			if (taken !== undefined) before.set(probe.path, taken.text)
		}
		if (before.size === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"none of the declared routes could be read before the write",
			)
		}

		const created = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, created, this.id))
			return standDown("a documented feature gate refused the request")
		if (created.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the create returned ${created.status}, so nothing was invalidated`,
			)
		}

		for (const probe of probes) {
			const prior = before.get(probe.path)
			if (prior === undefined) continue
			const taken = await snapshot(probe)
			if (taken === undefined) continue
			const after = taken.exchange
			if (taken.text !== prior) continue

			return ctx.findings
				.attributed([
					...(graded(ctx, createOp) ? [createOp.operationId] : []),
					...(graded(ctx, probe.op) ? [probe.op.operationId] : []),
				])
				.backend(
					this.id,
					ctx.entityName,
					"a route the document says is invalidated by this write did not change",
					`creating a ${ctx.entityName} declares x-invalidate on "${probe.op.route}", but that ` +
						"route returned a byte-identical body before and after the write. Either it serves " +
						"a value derived from this entity and that value is stale — a denormalised counter " +
						"or a cached projection nobody refreshed — or the declaration is wrong and every " +
						"client following it is invalidating the wrong cache key.",
					[created, after],
				)
		}
		return ASSERTED
	},
}

/**
 * One fact, asserted through every projection that can express it.
 *
 * Every other check judges a projection against an expectation: does `filter` narrow, does
 * `select` project, does the detail route serve what was written. Each can pass while the
 * projections still contradict *each other* — the detail route says "active", the listing says
 * "pending", the filtered query returns the record for both. Nothing in a per-projection check
 * notices, because each one is individually defensible.
 *
 * So this reads a single field of a single record through the item route, the collection, a
 * sparse fieldset, an equality filter, its negation, and a sorted page, and requires them to
 * agree. It cannot say which projection is wrong — only that at least one is, which is the
 * honest claim and enough to act on. Where they disagree the report names every projection and
 * what each returned, so the odd one out is visible at a glance.
 *
 * This is the criss-cross property: a fact is not "in the database", it is whatever each read
 * path says it is, and a system is only consistent if they say the same thing.
 */
const projectionsAgree: Check<{ id: string; field: string; target: Record_; readOp: OperationModel }> = {
	plan: (ctx) => {
		const target = ctx.records[0]
		const readOp = ctx.readOp
		if (target === undefined || readOp === undefined) return cannot()
		/*
		 * A filterable, sortable, non-null, *client-owned* field.
		 *
		 * Server-generated fields are excluded deliberately: a progress counter, a derived row
		 * count or a status the backend advances can legitimately differ between two reads taken
		 * moments apart, and since oat tests entities concurrently a derived value may move
		 * mid-check for reasons no read path is responsible for. Comparing those across
		 * projections measures timing, not consistency.
		 */
		const generated = new Set([...(ctx.createOp?.generated ?? []), ...(ctx.updateOp?.generated ?? [])])
		const field = (ctx.query?.filterable ?? []).find(
			(name) =>
				name !== ctx.identity &&
				!generated.has(name) &&
				(ctx.query?.sortable ?? []).includes(name) &&
				target[name] !== null &&
				target[name] !== undefined &&
				typeof target[name] !== "object",
		)
		if (field === undefined) return cannot("a client-owned field that is filterable, sortable and set on a record")
		return ready({ field, id: String(target[ctx.identity]), readOp, target })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"pagination.page-walk-covers-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		/* Each projection is exercised elsewhere. When one is already known broken, its
		 * disagreement here is that same defect seen a second time. */
		"filter.equality-selects-exactly-one",
		"select.projection-honoured",
		"select.requested-fields-present",
		"sort.order-is-applied",
	],
	id: "consistency.projections-agree",
	needs: "an item route and a record with a comparable field",
	subjects: subjectsOf.readAndList,
	async run(ctx, { field, id, readOp }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const seen: Array<{ projection: string; value: unknown }> = []
		const record = (result: ListResult): Record_ | undefined =>
			result.items.find((item) => String(item[ctx.identity]) === id)

		const detail = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
		if (detail.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the item route returned ${detail.status}, leaving no reference value to compare against`,
			)
		}
		/*
		 * The item route read *now* is the reference, not the value oat submitted at seed time.
		 * A backend is entitled to normalise what it stores — trimming, case-folding, rounding —
		 * and holding every projection to the submitted value would report that as inconsistency.
		 * The claim being tested is that the read paths agree with each other, which is exactly
		 * what anchoring on one of them and comparing the rest establishes.
		 */
		const value = (detail.responseBody as Record_)[field]
		const rendered = String(value)

		const plain = await list(ctx, q(ctx, { limit }))
		const inList = record(plain)
		if (inList !== undefined) seen.push({ projection: "collection", value: inList[field] })

		const conventions = conv(ctx)
		if (conventions.select !== undefined) {
			const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
			const projected = projection === null ? null : await list(ctx, { ...q(ctx, { limit }), ...projection })
			const row = projected === null ? undefined : record(projected)
			if (row !== undefined) seen.push({ projection: "sparse fieldset", value: row[field] })
		}

		if (conventions.order !== undefined) {
			const sorted = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
			const row = record(sorted)
			if (row !== undefined) seen.push({ projection: "sorted page", value: row[field] })
		}

		const disagreeing = seen.filter((entry) => JSON.stringify(entry.value) !== JSON.stringify(value))
		if (disagreeing.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"the same record carries different values depending on how it is read",
				`${ctx.entityName} ${id} has "${field}" = ${JSON.stringify(value)} on the record oat ` +
					`created, but ${disagreeing
						.map((entry) => `the ${entry.projection} returns ${JSON.stringify(entry.value)}`)
						.join(", and ")}. At least one read path is serving something the others are not; ` +
					"a client's view of a record then depends on which route it happened to use.",
				[detail, plain.exchange],
			)
		}

		/* Membership is a projection too: a filter that matches the value must return the record,
		 * its negation must not, and both are read off the same fact just proven consistent.
		 * Equality says nothing about null — whether `eq` matches a null is the backend's
		 * convention, not a contract — so a null value has no membership to test. */
		if (value === null || value === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`"${field}" is null on the item route, and equality is not defined for null`,
			)
		}
		const matching = filterTerm(conventions, field, "eq", rendered)
		if (matching === null) return standDown("the filter grammar cannot express this probe")
		/* The whole filtered set, not its first page: absence from one page proves nothing. */
		const included = await collectSet(ctx, limit, matching)
		if (included === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `filtering on "${field}" was rejected`)
		}
		if (included.items.some((item) => String(item[ctx.identity]) === id)) return ASSERTED
		if (!included.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered set is larger than the walk covers, so the record's absence is not established",
			)
		}

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a record is missing from a filter matching its own field value",
			`${ctx.entityName} ${id} carries "${field}" = ${JSON.stringify(value)} on every read path, ` +
				`yet filtering for exactly that value does not return it. The record and the predicate ` +
				"agree; the index or query that answers the filter does not.",
			[detail, included.last.exchange],
		)
	},
}

/**
 * Query axes must compose: a filter and a sort applied together must agree with each applied alone.
 *
 * Every other query check exercises one axis in isolation, and that is where the isolation stops
 * being realistic. Real backends break at the *combination*: adding a sort changes which index the
 * planner picks and the filter stops being applied; a cursor is resolved before the filter, so page
 * two leaks rows the predicate excluded; a count is computed on the unfiltered set the moment an
 * order is present. Each of those passes a suite that only ever tests one axis at a time.
 *
 * The property asserted is compositional, so it needs no ground truth: filtering then sorting must
 * yield exactly the same *set* as filtering alone — reordered, but never a different membership.
 * A sort is not a predicate, and it must not behave as one.
 */
const queryAxesCompose: Check<Subset & { sortField: string }> = {
	plan: (ctx) => {
		if (!filterable(ctx) || conv(ctx).order === undefined || ctx.records.length <= 2) return cannot()
		if ((ctx.query?.sortable.length ?? 0) === 0) return cannot()
		const subset = subsetPlan(ctx)
		return subset.ok ? ready({ ...subset.value, sortField: sortFieldBeside(ctx, subset.value.field) }) : subset
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		/* Each axis has to work alone before "they disagree when combined" means anything. */
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honoured",
		/* Both sides are gathered by walking pages, so a walk that skips or repeats records
		 * changes the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "query.axes-compose",
	needs: "a filterable field, a sortable field, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, sortField, term }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)

		/*
		 * Both sides gathered across pages. Comparing single pages would compare two *windows* of
		 * the same set — a sorted page and an unsorted one legitimately hold different records once
		 * the set is larger than one page, and the difference would be read as a dropped filter.
		 */
		const filtered = await collectSet(ctx, limit, term)
		const both = await collectSet(ctx, limit, term, sortTerm(conventions, sortField, "desc"))
		if (filtered === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort was rejected, so the two cannot be compared",
			)
		}
		if (!filtered.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered set is larger than the walk covers, so the two runs cannot be compared " + "as whole sets",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(both.items, ctx.identity))
		const missing = [...alone].filter((id) => !combined.has(id))
		const extra = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
				`order=${sortField} desc matched ${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Appeared: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"Ordering must reorder a result, never change its membership — a filter that only " +
				"holds while unsorted is one an index or query plan is silently dropping.",
			[filtered.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A filter must select from the whole collection, not from whichever page happened to be built.
 *
 * The failure this catches is one of *ordering of operations*: resolve the offset or cursor first,
 * then apply the predicate to whatever that window contained. Page one usually looks correct,
 * which is how it survives review — the damage is further in, where pages come back short and
 * matching records are never returned at all.
 *
 * The oracle needs no ground truth because oat can compute the answer two ways. Walk the
 * collection unfiltered and apply the predicate client-side; walk it again with the predicate
 * pushed to the server. A backend that filters before paging returns the same set both times. One
 * that pages first returns a subset, and the difference is exactly the records it skipped.
 */
const filterAndPagingCompose: Check<Subset & { value: unknown }> = {
	plan: (ctx) =>
		andThen(when(filterable(ctx) && ctx.records.length > 2), () =>
			andThen(subsetPlan(ctx), (subset) => ready({ ...subset, value: subset.target[subset.field] })),
		),
	/*
	 * A foundation, not a composition: every check that reads a filtered set relies on the filter
	 * applying to the whole collection, so they depend on this and not the other way round. A
	 * filter dropped once a sort is present is walked around without the sort; one ignored outright
	 * leaves this unresolved, and the check that owns that defect reports it.
	 */
	dependsOn: [
		"list.read-after-write",
		/* Both sides are walks, so a broken walk changes both for reasons that are not about
		 * where the predicate is applied. */
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-selects-from-whole-set",
	needs: "a filterable field and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, term, value }): Promise<Outcome> {
		const conventions = conv(ctx)
		/* One row per page, deliberately: the bug only shows once a window excludes matching rows,
		 * and a one-row window that does not match comes back empty and ends the walk, so every
		 * later match is lost. Any larger page leaves detection to how matches happen to fall. */
		const pageSize = 1

		const tiebreak = (ctx.query?.sortable ?? []).includes(ctx.identity) ? ctx.identity : undefined
		const walkOrder = tiebreak === undefined ? undefined : sortTerm(conventions, tiebreak, "asc")
		const matches = (row: Record_): boolean => JSON.stringify(row[field]) === JSON.stringify(value)
		let everything = await collectSet(ctx, pageSize, {}, walkOrder)
		let serverSide = await collectSet(ctx, pageSize, term, walkOrder)
		/* Rows that do not match mean the filter was not applied to this walk. A backend that
		 * drops the filter once a sort is present does exactly that to the sorted walk, and every
		 * row it skipped would hide among the extras — so walk again without the sort. */
		if (walkOrder !== undefined && serverSide !== null && !serverSide.items.every(matches)) {
			everything = await collectSet(ctx, pageSize, {})
			serverSide = await collectSet(ctx, pageSize, term)
		}
		if (everything === null || serverSide === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection could not be walked in both filtered and unfiltered form",
			)
		}
		if (!everything.complete || !serverSide.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two sets are not comparable",
			)
		}

		if (!serverSide.items.every(matches)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filter was not applied at all, so where it is applied cannot be judged",
			)
		}

		/* The predicate applied by oat, over everything the API served. */
		const clientSide = new Set(everything.items.filter(matches).map((row) => String(row[ctx.identity])))
		const returned = new Set(ids(serverSide.items, ctx.identity))
		const skipped = [...clientSide].filter((id) => !returned.has(id))
		if (skipped.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"paging a filtered query skips records that match the filter",
			`walking the collection at ${pageSize} per page and filtering client-side on ` +
				`"${field}" = ${JSON.stringify(value)} finds ${clientSide.size} record(s); asking the ` +
				`backend for the same filter returns ${returned.size}. Never returned: ` +
				`${skipped.slice(0, 3).join(", ")}. The page window is being computed before the ` +
				"predicate is applied, so matching records fall outside it and are lost — page one " +
				"looks correct and later pages silently omit data.",
			[everything.last.exchange, serverSide.last.exchange],
		)
	},
}

/**
 * A filter and a sparse fieldset must compose: projecting columns must never change which
 * records match.
 *
 * The failure this catches is a query builder that projects first and then cannot apply a
 * predicate to a column it just omitted, or that takes a different path the moment `fields=` is
 * present and forgets the WHERE. Each axis is correct alone — the filter returns the right set,
 * the select returns the right columns — and together the filter silently vanishes.
 *
 * The oracle is the same compositional property as {@link queryAxesCompose}: the filter alone
 * and the same filter with a select must return the same **set**. Identity is always requested
 * so the two sides remain comparable.
 */
const filterAndSelectCompose: Check<Subset & { extra: string; projection: Record<string, string> }> = {
	plan: (ctx) => {
		if (!filterable(ctx) || conv(ctx).select === undefined || ctx.records.length <= 2) return cannot()
		const subset = subsetPlan(ctx)
		if (!subset.ok) return subset
		const projected = projectionBeside(ctx)
		return projected === null
			? cannot("a select grammar that can express a sparse fieldset")
			: ready({ ...subset.value, ...projected })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		/* If select is accepted and ignored, both sides still carry every column and the
		 * membership comparison remains well-defined — but a backend that has stopped honouring
		 * select at all may also have stopped taking the code path this check is probing. */
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-and-select-compose",
	needs: "a filterable field, a select parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { extra, field, projection, term }): Promise<Outcome> {
		const limit = pageSize(ctx)

		const filtered = await collectSet(ctx, limit, term)
		const both = await collectSet(ctx, limit, { ...term, ...projection })
		if (filtered === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a select was rejected, so the two cannot be compared",
			)
		}
		if (!filtered.complete || !both.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered set is larger than the walk covers, so the two runs cannot be compared " + "as whole sets",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(both.items, ctx.identity))
		/* A projection that omitted the identity makes membership unobservable — that is a
		 * missing column, not a changed set, and select.projection-honoured already owns it. */
		if (both.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}
		const missing = [...alone].filter((id) => !combined.has(id))
		const extraIds = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a select changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
				`select=${[ctx.identity, extra].join(",")} matched ${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A projection must change which columns come back, never which rows — a filter " +
				"that only holds while every column is selected is one a query plan is dropping " +
				"once it has to name the columns.",
			[filtered.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A structured filter and a free-text search must compose as their intersection.
 *
 * Adding `q` often switches a backend onto a search-index path that does not honour the
 * structured predicate — or the reverse: a filter makes the search term a no-op. Each axis is
 * correct alone; together one of them vanishes. The oracle needs no ground truth: walk each
 * axis, walk both, and the combined set must equal the intersection.
 *
 * The two sides have to overlap without nesting. If the search matches only records the filter
 * already selected, dropping the filter is invisible — the combined set still equals the
 * intersection. The token is chosen so each axis matches something the other does not.
 */
const searchAndFilterCompose: Check<Subset & { token: string }> = {
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).search !== undefined &&
					(ctx.query?.searchable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() => overlapPlan(ctx),
		),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"pagination.page-walk-covers-set",
	],
	id: "query.search-and-filter-compose",
	needs: "a filterable field, a free-text search parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, term, token }): Promise<Outcome> {
		const limit = pageSize(ctx)

		const filtered = await collectSet(ctx, limit, term)
		if (filtered === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered listing was rejected, so it cannot be compared with a search",
			)
		}
		if (!filtered.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered set is larger than the walk covers")
		}

		const filterIds = new Set(ids(filtered.items, ctx.identity))
		const searched = await collectSet(ctx, limit, q(ctx, { search: token }) as Record<string, string>)
		const both = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		if (searched === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a search was rejected, so the two cannot be compared",
			)
		}
		if (!searched.complete || !both.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const searchIds = new Set(ids(searched.items, ctx.identity))
		const expected = new Set([...filterIds].filter((id) => searchIds.has(id)))
		const got = new Set(ids(both.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a filter and a search do not compose as their intersection",
			`filter on "${field}" matched ${filterIds.size}; q=${JSON.stringify(token)} matched ` +
				`${searchIds.size}; both together matched ${got.size} (intersection is ` +
				`${expected.size}). ` +
				(missing.length > 0 ? `Missing: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Extra: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A structured predicate and a free-text search must narrow each other. When they " +
				"do not, one of them is being dropped the moment the other is present.",
			[filtered.last.exchange, searched.last.exchange, both.last.exchange],
		)
	},
}

/**
 * A filter, a sort and a select must compose: adding both extra axes must not change which
 * records the filter matches.
 *
 * Pairwise composition is not enough. A planner that has a working two-axis path and a
 * broken three-axis path — the moment `order` and `fields` are both present, the WHERE is
 * dropped — passes every pair check. The oracle is the same membership property as the
 * pairs: the filter alone and the filter with both extras must return the same set.
 */
const filterSortSelectCompose: Check<
	Subset & { extra: string; projection: Record<string, string>; sortField: string }
> = {
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).order !== undefined &&
					conv(ctx).select !== undefined &&
					(ctx.query?.sortable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() =>
				andThen(subsetPlan(ctx), (subset) => {
					const projected = projectionBeside(ctx)
					if (projected === null) return cannot("a select grammar that can express a sparse fieldset")
					return ready({ ...subset, ...projected, sortField: sortFieldBeside(ctx, subset.field) })
				}),
		),
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
		/* Each pair has to hold before "the triple disagrees" means anything. A pair defect
		 * would also break this request, and reporting it again would name the wrong cause. */
		"query.axes-compose",
		"query.filter-and-select-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-sort-select-compose",
	needs: "a filterable field, a sortable field, a select parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { extra, field, projection, sortField, term }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)

		const filtered = await collectSet(ctx, limit, term)
		const triple = await collectSet(ctx, limit, { ...term, ...projection }, sortTerm(conventions, sortField, "desc"))
		if (filtered === null || triple === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort and a select was rejected",
			)
		}
		if (!filtered.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (triple.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(triple.items, ctx.identity))
		const missing = [...alone].filter((id) => !combined.has(id))
		const extraIds = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort and a select together changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size}; the same filter with ` +
				`order=${sortField} desc and select=${[ctx.identity, extra].join(",")} matched ` +
				`${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"Each pair composes; the triple must too. A filter that only holds until both a " +
				"sort and a projection are present is one a three-axis query plan is dropping.",
			[filtered.last.exchange, triple.last.exchange],
		)
	},
}

/**
 * A filter, a search and a sort must compose: the intersection of filter and search must not
 * change when a sort is added.
 *
 * The search-index path that also tries to honour an ORDER BY is a common place to drop the
 * structured predicate. Pairwise, filter+search and filter+sort both hold; together they do not.
 */
const filterSearchSortCompose: Check<Subset & { token: string; sortField: string }> = {
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).search !== undefined &&
					conv(ctx).order !== undefined &&
					(ctx.query?.searchable.length ?? 0) > 0 &&
					(ctx.query?.sortable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() =>
				andThen(overlapPlan(ctx), (overlap) => ready({ ...overlap, sortField: sortFieldBeside(ctx, overlap.field) })),
		),
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"sort.order-is-applied",
		"pagination.page-walk-covers-set",
		"query.search-and-filter-compose",
		"query.axes-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-search-sort-compose",
	needs: "a filterable field, a search parameter, a sortable field, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, sortField, term, token }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)
		const pair = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		const triple = await collectSet(
			ctx,
			limit,
			{ ...term, ...q(ctx, { search: token }) } as Record<string, string>,
			sortTerm(conventions, sortField, "desc"),
		)
		if (pair === null || triple === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "combining a filter, a search and a sort was rejected")
		}
		if (!pair.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const expected = new Set(ids(pair.items, ctx.identity))
		const got = new Set(ids(triple.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter and a search return",
			`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
				`the same request with order=${sortField} desc matched ${got.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A sort must reorder the intersection, never change it.",
			[pair.last.exchange, triple.last.exchange],
		)
	},
}

/**
 * A filter, a search and a select must compose: projecting columns must not change the
 * intersection of filter and search.
 */
const filterSearchSelectCompose: Check<Subset & { token: string; extra: string; projection: Record<string, string> }> =
	{
		plan: (ctx) =>
			andThen(
				when(
					filterable(ctx) &&
						conv(ctx).search !== undefined &&
						conv(ctx).select !== undefined &&
						(ctx.query?.searchable.length ?? 0) > 0 &&
						ctx.records.length > 2,
				),
				() =>
					andThen(overlapPlan(ctx), (overlap) => {
						const projected = projectionBeside(ctx)
						return projected === null
							? cannot("a select grammar that can express a sparse fieldset")
							: ready({ ...overlap, ...projected })
					}),
			),
		dependsOn: [
			"list.read-after-write",
			"create.persists-submitted-fields",
			"filter.equality-selects-exactly-one",
			"search.q-narrows-result",
			"select.projection-honoured",
			"pagination.page-walk-covers-set",
			"query.search-and-filter-compose",
			"query.filter-and-select-compose",
			"query.filter-selects-from-whole-set",
		],
		id: "query.filter-search-select-compose",
		needs: "a filterable field, a search parameter, a select parameter, and more than two records",
		subjects: subjectsOf.list,
		async run(ctx, { extra, field, projection, term, token }): Promise<Outcome> {
			const limit = pageSize(ctx)
			const pair = await collectSet(ctx, limit, {
				...term,
				...q(ctx, { search: token }),
			} as Record<string, string>)
			const triple = await collectSet(ctx, limit, {
				...term,
				...q(ctx, { search: token }),
				...projection,
			} as Record<string, string>)
			if (pair === null || triple === null) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"combining a filter, a search and a select was rejected",
				)
			}
			if (!pair.complete || !triple.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"a side of the comparison is larger than the walk covers",
				)
			}
			if (triple.items.some((item) => item[ctx.identity] === undefined)) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"the projected page omitted the identity field, so the two sets cannot be compared",
				)
			}

			const expected = new Set(ids(pair.items, ctx.identity))
			const got = new Set(ids(triple.items, ctx.identity))
			const missing = [...expected].filter((id) => !got.has(id))
			const extraIds = [...got].filter((id) => !expected.has(id))
			if (missing.length === 0 && extraIds.length === 0) return ASSERTED

			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"adding a select changes which records a filter and a search return",
				`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
					`the same request with select=${[ctx.identity, extra].join(",")} matched ${got.size}. ` +
					(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
					(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
					"A projection must change columns, never the intersection a filter and a search " +
					"already agreed on.",
				[pair.last.exchange, triple.last.exchange],
			)
		},
	}

/** The create operation and its request schema: what every create-validation probe starts from. */
interface CreateBody {
	createOp: OperationModel
	schema: Record<string, unknown>
}

function createBodyPlan(ctx: CheckContext): Plan<CreateBody> {
	const createOp = ctx.createOp
	if (createOp === undefined) return cannot()
	const schema = requestSchemaOf(ctx, createOp)
	return schema === null ? cannot("a create operation with a request schema") : ready({ createOp, schema })
}

/** Facts about one entity's cohort, computed once and shared by every check that asks. */
const cohortFacts = new WeakMap<readonly Record_[], Map<string, unknown>>()

/**
 * A fact about the seeded cohort — a tied sort field, a proper-subset filter, an overlapping
 * search token. The cohort is never written after seeding, so the answer cannot go stale; keyed
 * by list operation too, because a fact about one listing's capabilities is not one about another.
 */
function cohortFact<T>(ctx: CheckContext, name: string, compute: () => T): T {
	const facts = cohortFacts.get(ctx.records) ?? new Map<string, unknown>()
	cohortFacts.set(ctx.records, facts)
	const key = `${ctx.listOp.operationId}:${name}`
	if (facts.has(key)) return facts.get(key) as T
	const value = compute()
	facts.set(key, value)
	return value
}

/** A filter selecting a proper subset of the cohort, and the record it was built from. */
interface Subset {
	field: string
	target: Record_
	term: Record<string, string>
}

/**
 * A field, and a value on it, selecting a *proper subset* of the cohort: more than one record so
 * there is something to reorder or project, and fewer than all so a dropped predicate is visible
 * as a change in membership. A value matching everything would make the filtered and unfiltered
 * sets identical, and a composition check would pass whatever the backend did.
 */
function subsetPlan(ctx: CheckContext): Plan<Subset> {
	const picked = properSubsetFilter(ctx)
	if (picked === null) return cannot("a filterable value shared by several cohort records but not all of them")
	const term = filterTerm(conv(ctx), picked.field, "eq", String(picked.target[picked.field]))
	return term === null
		? cannot(`a filter grammar that can express equality on "${picked.field}"`)
		: ready({ ...picked, term })
}

/** A proper-subset filter and a search token that overlap without nesting. */
function overlapPlan(ctx: CheckContext): Plan<Subset & { token: string }> {
	const picked = overlappingFilterAndSearch(ctx)
	if (picked === null) return cannot("a filterable value and a search token that overlap without nesting")
	const term = filterTerm(conv(ctx), picked.field, "eq", String(picked.target[picked.field]))
	return term === null
		? cannot(`a filter grammar that can express equality on "${picked.field}"`)
		: ready({ ...picked, term })
}

/** A sparse fieldset of the identity and one other selectable field. */
function projectionBeside(ctx: CheckContext): { extra: string; projection: Record<string, string> } | null {
	const extra = (ctx.query?.selectable ?? []).find((name) => name !== ctx.identity) ?? ctx.identity
	const projection = selectTerm(conv(ctx), [ctx.identity, extra], ctx.entityName)
	return projection === null ? null : { extra, projection }
}

/** A sortable field other than `field` and the identity, else the identity. */
function sortFieldBeside(ctx: CheckContext, field: string): string {
	return (ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity) ?? ctx.identity
}

/** A filterable field whose value selects a proper subset of the cohort. */
function properSubsetFilter(ctx: CheckContext): { field: string; target: Record_ } | null {
	return cohortFact(ctx, "proper-subset", () => findProperSubset(ctx))
}

function findProperSubset(ctx: CheckContext): { field: string; target: Record_ } | null {
	for (const candidate of ctx.query?.filterable ?? []) {
		if (candidate === ctx.identity) continue
		const values = ctx.records.map((record) => JSON.stringify(record[candidate]))
		const match = ctx.records.find((record) => {
			if (record[candidate] === null || record[candidate] === undefined) return false
			const count = values.filter((v) => v === JSON.stringify(record[candidate])).length
			return count > 1 && count < ctx.records.length
		})
		if (match !== undefined) return { field: candidate, target: match }
	}
	return null
}

/**
 * A filter value and a search token that overlap without nesting, so dropping either axis
 * changes the intersection.
 */
function overlappingFilterAndSearch(ctx: CheckContext): { field: string; target: Record_; token: string } | null {
	return cohortFact(ctx, "overlap", () => findOverlap(ctx))
}

function findOverlap(ctx: CheckContext): { field: string; target: Record_; token: string } | null {
	for (const candidate of ctx.query?.filterable ?? []) {
		if (candidate === ctx.identity) continue
		const groups = new Map<string, Record_[]>()
		for (const record of ctx.records) {
			if (record[candidate] === null || record[candidate] === undefined) continue
			const key = JSON.stringify(record[candidate])
			const group = groups.get(key) ?? []
			group.push(record)
			groups.set(key, group)
		}
		for (const group of groups.values()) {
			if (group.length <= 1 || group.length >= ctx.records.length) continue
			const sample = group[0]
			if (sample === undefined) continue
			const found = overlappingSearchToken(ctx, new Set(ids(group, ctx.identity)))
			if (found === null) continue
			return { field: candidate, target: sample, token: found }
		}
	}
	return null
}

/**
 * A search token that overlaps a filtered set without nesting — each side matches something
 * the other does not, so dropping either axis changes the intersection.
 */
function overlappingSearchToken(ctx: CheckContext, filterIds: Set<string>): string | null {
	const fields = ctx.query?.searchable ?? []
	if (fields.length === 0) return null

	const matches = (token: string): Set<string> => {
		const needle = token.toLowerCase()
		const hit = new Set<string>()
		for (const record of ctx.records) {
			if (
				fields.some((field) =>
					String(record[field] ?? "")
						.toLowerCase()
						.includes(needle),
				)
			) {
				hit.add(String(record[ctx.identity]))
			}
		}
		return hit
	}

	const candidates: string[] = []
	for (const record of ctx.records) {
		for (const name of fields) {
			const value = record[name]
			if (typeof value !== "string" || value.length < 2) continue
			candidates.push(value)
			if (value.length >= 3) candidates.push(value.slice(0, 3))
			for (const word of value.split(/\s+/)) {
				if (word.length >= 2) candidates.push(word)
			}
		}
	}

	for (const token of candidates) {
		const searchIds = matches(token)
		const inter = [...searchIds].filter((id) => filterIds.has(id)).length
		const onlySearch = [...searchIds].filter((id) => !filterIds.has(id)).length
		const onlyFilter = [...filterIds].filter((id) => !searchIds.has(id)).length
		if (inter > 0 && onlySearch > 0 && onlyFilter > 0) return token
	}
	return null
}

/**
 * A capability the document declares must actually exist.
 *
 * `x-query.filterable` is a promise: every client generated from that document will offer a filter
 * on each field named there. When the backend rejects one, the backend is not necessarily wrong —
 * it is entitled to refuse a column it never indexed — but the *document* is, and it is wrong in
 * the most expensive way, because the failure only appears at runtime in someone else's client.
 *
 * oat is uniquely positioned to catch this: it is the only thing that reads the claim and then
 * tries it. Note the verdict is SPEC_BUG rather than BACKEND_BUG — the fix is to correct the
 * document or index the column, and saying which is not oat's call.
 *
 * This also closes a silent-skip: every filter check treats a 4xx as a capability statement and
 * stands down, which is right when the field was merely inferred and wrong when it was declared.
 */
const declaredFilterableWorks: Check = {
	plan: (ctx) =>
		when(
			conv(ctx).filter !== undefined &&
				ctx.query?.source === "tag" &&
				(ctx.query?.filterable.length ?? 0) > 0 &&
				ctx.records.length > 0,
		),
	dependsOn: [
		"list.read-after-write",
		/* The evidence is a *rejection*. A backend that silently drops unknown filter fields never
		 * rejects anything, so an overclaimed field comes back 200 and this check would report the
		 * document as honest — the dropped-filter defect is the finding to act on first. */
		"filter.unknown-field-rejected",
		/* And only a 4xx counts: a backend whose filter parser throws answers *every* bad filter
		 * with a 500, which makes "the document declared a field the backend refuses"
		 * indistinguishable from "the parser is broken". That is the finding to fix first. */
		"error.malformed-filter-not-5xx",
	],
	id: "spec.declared-filterable-is-filterable",
	needs: "x-query naming filterable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number; exchange: Exchange }> = []
		const unknown: string[] = []
		let probed = 0

		/* Every field at once; the answers are judged in declaration order. */
		const answers = await Promise.all(
			(ctx.query?.filterable ?? []).map(async (field) => {
				/* A declared field that never appears on the cohort is still a promise — often the
				 * most expensive kind, a column the document invented. It is probed with an operator
				 * the field allows and a value of the field's own type: a backend that rejects a
				 * string compared with a number is right to, and that says nothing about the field. */
				const probe = capabilityProbe(ctx, field)
				if (probe === null) return null
				const term = filterTerm(conventions, field, probe.op, probe.value)
				if (term === null) return null
				return { field, result: await list(ctx, { ...q(ctx, { limit: 5 }), ...term }) }
			}),
		)
		for (const answered of answers) {
			if (answered === null) continue
			const { field, result } = answered
			probed += 1
			/* Only a rejection counts. A filter that returns the wrong rows is a backend defect
			 * other checks own; this one is strictly about the capability existing. */
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") rejected.push({ exchange: result.exchange, field, status: result.exchange.status })
			if (answer === "unknown") unknown.push(`${field} (${result.exchange.status})`)
		}

		if (probed === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no declared filterable field holds a non-null value in the cohort, so none could be probed",
			)
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a filter the backend does not accept",
			`x-query lists ${rejected.length} field(s) as filterable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a filter that fails at runtime. " +
				"Either the column needs an index or the declaration needs removing — but the " +
				"document and the backend currently disagree about what this API can do.",
			rejected.slice(0, 3).map((item) => item.exchange),
		)
	},
}

/**
 * The sort analogue of {@link declaredFilterableWorks}: `x-query.sortable` is a promise too, and
 * an `order` value the backend rejects breaks every client generated from the document exactly
 * the same way a rejected filter does.
 */
const declaredSortableWorks: Check = {
	plan: (ctx) =>
		when(
			conv(ctx).order !== undefined &&
				ctx.query?.source === "tag" &&
				(ctx.query?.sortable.length ?? 0) > 0 &&
				ctx.records.length > 0,
		),
	dependsOn: [
		"list.read-after-write",
		/* ERROR_500_ON_BAD_FILTER, despite its name, turns *any* SqlError the reference throws
		 * into a 500 — including a rejected `order` field, not just a malformed filter. Without
		 * this dependency a rejection lands outside the 4xx window this check looks for and the
		 * overclaim goes unreported: the same "SILENT" failure error.malformed-filter-not-5xx
		 * exists to catch, just reached from the sort path instead of the filter path. */
		"error.malformed-filter-not-5xx",
		/* Found by the fuzzer, not the matrix: on the SQL stores, ORDER_IGNORED short-circuits
		 * before the sortable whitelist is even consulted (the field-rejection check sits *after*
		 * the ignore-order early return), so a backend that has stopped applying `order` at all
		 * also stops rejecting an overclaimed field — the request simply succeeds with the default
		 * order. The overclaim is real but unobservable until ordering itself works again. */
		"sort.order-is-applied",
	],
	id: "spec.declared-sortable-is-sortable",
	needs: "x-query naming sortable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number; exchange: Exchange }> = []
		const unknown: string[] = []
		let probed = 0

		const answers = await Promise.all(
			(ctx.query?.sortable ?? []).map(async (field) => ({
				field,
				result: await list(ctx, q(ctx, { limit: 5, order: sortTerm(conventions, field, "asc") })),
			})),
		)
		for (const { field, result } of answers) {
			probed += 1
			/* Only a rejection counts. Order accepted but not applied is sort.order-is-applied's
			 * finding, not a capability claim breaking. */
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") rejected.push({ exchange: result.exchange, field, status: result.exchange.status })
			if (answer === "unknown") unknown.push(`${field} (${result.exchange.status})`)
		}

		if (probed === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no declared sortable field could be probed")
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a sort field the backend does not accept",
			`x-query lists ${rejected.length} field(s) as sortable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer an order value that fails at " +
				"runtime. Either the column needs an index or the declaration needs removing — but " +
				"the document and the backend currently disagree about what this API can do.",
			rejected.slice(0, 3).map((item) => item.exchange),
		)
	},
}

/**
 * The select analogue of {@link declaredFilterableWorks} and {@link declaredSortableWorks}:
 * `x-query.selectable` is a promise too, and a sparse fieldset the backend rejects breaks every
 * client generated from the document exactly the same way a rejected filter or sort does.
 */
const declaredSelectableWorks: Check = {
	plan: (ctx) =>
		when(
			conv(ctx).select !== undefined &&
				ctx.query?.source === "tag" &&
				(ctx.query?.selectable.length ?? 0) > 0 &&
				ctx.records.length > 0,
		),
	dependsOn: [
		"list.read-after-write",
		/* Same masking risk as the filter and sort overclaim checks: ERROR_500_ON_BAD_FILTER turns
		 * any rejection — this one included — into a 500, which would fall outside the 4xx window
		 * below and read as accepted. */
		"error.malformed-filter-not-5xx",
		/* Same shape as the sort check's dependency on sort.order-is-applied, found by inspection
		 * before the fuzzer had to: `project()` returns the row untouched under SELECT_IGNORED
		 * *before* the excluded-field check runs, so a backend that has stopped honouring `select`
		 * at all also stops rejecting an overclaimed field — the request just returns every column. */
		"select.projection-honoured",
	],
	id: "spec.declared-selectable-is-selectable",
	needs: "x-query naming selectable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number; exchange: Exchange }> = []
		const unknown: string[] = []
		let probed = 0

		const answers = await Promise.all(
			(ctx.query?.selectable ?? []).map(async (field) => {
				const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
				if (projection === null) return null
				return { field, result: await list(ctx, { ...q(ctx, { limit: 5 }), ...projection }) }
			}),
		)
		for (const answered of answers) {
			if (answered === null) continue
			const { field, result } = answered
			probed += 1
			/* Only a rejection counts. A field accepted and then ignored is select.projection-
			 * honoured's finding, not a capability claim breaking. */
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") rejected.push({ exchange: result.exchange, field, status: result.exchange.status })
			if (answer === "unknown") unknown.push(`${field} (${result.exchange.status})`)
		}

		if (probed === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no declared selectable field could be probed")
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a select field the backend does not accept",
			`x-query lists ${rejected.length} field(s) as selectable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a sparse fieldset that fails at " +
				"runtime. Either the field needs to stay projectable or the declaration needs " +
				"removing — but the document and the backend currently disagree about what this API " +
				"can do.",
			rejected.slice(0, 3).map((item) => item.exchange),
		)
	},
}

const crossTenantItemRead: Check<{ id: string; readOp: OperationModel; altAuth: () => Record<string, string> }> = {
	plan: (ctx) => {
		const { altAuth, readOp } = ctx
		const target = ctx.records[0]
		if (altAuth === undefined || readOp === undefined || target === undefined || !tenantBoundary(readOp)) {
			return cannot()
		}
		return ready({ altAuth, id: String(target[ctx.identity]), readOp })
	},
	id: "tenant.item-not-readable-cross-tenant",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.read,
	async run(ctx, { altAuth, id, readOp }): Promise<Outcome> {
		const params = { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }
		const exchange = await ctx.client.get(fillPath(readOp.path, params), {
			headers: altAuth(),
		})
		if (exchange.status === 403 || exchange.status === 404) return ASSERTED
		if (exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the cross-tenant read failed for another reason")

		/* Only assert a breach when the document says the route is tenant-scoped. Where oat merely
		 * guessed scoping from a path parameter, a shared catalogue and a data leak are the same
		 * observation, and claiming the worse one erodes trust in every other finding. */
		const declared = readOp.tenantSource === "tag"
		const detail =
			`${ctx.entityName} ${id} was created by one principal and read successfully ` +
			`(${exchange.status}) by a principal in a different tenant.`

		if (declared) {
			return ctx.findings.security(
				this.id,
				ctx.entityName,
				"a record is readable by a principal in another tenant",
				`${detail} The operation declares x-tenant: "${readOp.tenantParam}", so this ` +
					"crosses a boundary the document states exists.",
				[exchange],
			)
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${readOp.tenantParam}" path ` +
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
			entity: ctx.entityName,
			evidence: [exchange],
			summary: "a record crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
		return ASSERTED
	},
}

/**
 * Another tenant must not be able to change or remove a record.
 *
 * Isolation used to be tested on reads alone, and a backend that scopes its reads but looks its
 * writes up by id hands every tenant every other tenant's data to edit and delete. The probe runs
 * on a record made for it: the other tenant patches a field, then deletes the record, and the
 * owner reads it back. A refusal of either is right; a change or a deletion that took is the leak.
 */
const crossTenantItemWrite: Check<{
	readOp: OperationModel
	altAuth: () => Record<string, string>
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
}> = {
	plan: (ctx) => {
		const { altAuth, readOp } = ctx
		if (altAuth === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		const updateOp = ctx.updateOp !== undefined && tenantBoundary(ctx.updateOp) ? ctx.updateOp : undefined
		const deleteOp = ctx.deleteOp !== undefined && tenantBoundary(ctx.deleteOp) ? ctx.deleteOp : undefined
		if (updateOp === undefined && deleteOp === undefined) return cannot()
		return ready({ altAuth, deleteOp, readOp, updateOp })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "tenant.item-not-writable-cross-tenant",
	mutates: true,
	needs: "a second principal in a different tenant, a create, and a tenant-scoped update or delete",
	subjects: (entity) => declared(entity.update, entity.delete),
	async run(ctx, { altAuth, deleteOp, readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const { id, record } = made.scratch
		const own = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const foreign = { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }
		const reread = (): Promise<Exchange> => ctx.client.get(fillPath(readOp.path, own), { headers: ctx.auth() })

		const breach = (op: OperationModel, summary: string, detail: string, evidence: Exchange[]): Outcome => {
			if (op.tenantSource === "tag") {
				return ctx.findings.security(
					this.id,
					ctx.entityName,
					summary,
					`${detail} The operation declares x-tenant: "${op.tenantParam}".`,
					evidence,
				)
			}
			return ctx.findings.report({
				check: this.id,
				detail:
					`${detail} oat inferred tenant scoping from the "${op.tenantParam}" path parameter; ` +
					"declare x-tenant so the same result is SECURITY.",
				entity: ctx.entityName,
				evidence,
				summary,
				verdict: "AMBIGUITY",
			})
		}

		if (updateOp !== undefined) {
			const field = pickWritableStringField(ctx, record)
			const value = field === null ? undefined : changedValue(ctx, field, record[field], updateOp)
			if (field !== null && value !== undefined) {
				const update = await updateRequest(ctx, updateOp, record, { [field]: value })
				const attempt = await ctx.client.request(update.method, fillPath(updateOp.path, foreign), {
					...update.options,
					headers: altAuth(),
					operationId: updateOp.operationId,
				})
				const after = await reread()
				const now = ((after.responseBody ?? {}) as Record_)[field]
				if (after.status < 300 && JSON.stringify(now) === JSON.stringify(value)) {
					return breach(
						updateOp,
						"a record can be changed by a principal in another tenant",
						`${ctx.entityName} ${id} belongs to one tenant; a principal in another tenant set "${field}" ` +
							`(${attempt.status}) and the owner now reads the new value.`,
						[attempt, after],
					)
				}
			}
		}

		if (deleteOp !== undefined) {
			const attempt = await ctx.client.request("DELETE", fillPath(deleteOp.path, foreign), {
				headers: altAuth(),
				operationId: deleteOp.operationId,
			})
			const after = await reread()
			if (attempt.status < 300 && (after.status === 404 || after.status === 410)) {
				return breach(
					deleteOp,
					"a record can be deleted by a principal in another tenant",
					`${ctx.entityName} ${id} belongs to one tenant; a principal in another tenant deleted it ` +
						`(${attempt.status}) and the owner can no longer read it (${after.status}).`,
					[attempt, after],
				)
			}
		}
		return ASSERTED
	},
}

/**
 * The rank lattice holds for writes as it does for reads: a role that may create, update or
 * delete implies every higher role may too. A viewer that can edit what a member cannot is the
 * lattice inverted, and it is a write — the costly direction to get wrong.
 *
 * Each principal sharing the writer's tenant tries each write once, on a record made for the
 * try: creates go through the create operation, updates and deletes hit a scratch record each.
 */
const rankIsMonotonicOnWrites: Check<{ home: Actor[] }> = {
	plan: (ctx) => {
		const primary = ctx.actors[0]
		if (primary === undefined || ctx.createOp === undefined) return cannot()
		const home = ctx.actors.filter((actor) => sameTenantScope(actor.roots, primary.roots))
		if (new Set(home.map((actor) => actor.rank)).size < 2) return cannot()
		return ready({ home })
	},
	dependsOn: ["list.read-after-write", "auth.rank-is-monotonic"],
	id: "auth.rank-is-monotonic-on-writes",
	mutates: true,
	needs: "two same-tenant principals at different ranks, and a create",
	subjects: (entity) => declared(entity.create, entity.update, entity.delete),
	async run(ctx, { home }): Promise<Outcome> {
		type WriteVerdict = { allowed: boolean | null; exchange: Exchange }
		const judge = (exchange: Exchange): WriteVerdict => ({
			allowed: exchange.status < 300 ? true : exchange.status === 401 || exchange.status === 403 ? false : null,
			exchange,
		})
		const writes = new Map<string, Map<string, WriteVerdict>>()
		const note = (kind: string, actor: Actor, verdict: WriteVerdict): void => {
			writes.set(kind, (writes.get(kind) ?? new Map<string, WriteVerdict>()).set(actor.id, verdict))
		}
		const createOp = ctx.createOp as OperationModel
		const schema = requestSchemaOf(ctx, createOp)
		for (const actor of home) {
			if (schema !== null) {
				const created = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
					...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
					headers: actor.headers(),
					operationId: createOp.operationId,
				})
				note("create", actor, judge(created))
			}
			const updateOp = ctx.updateOp
			if (updateOp !== undefined) {
				const made = await scratchRecord(ctx, this.id)
				if ("outcome" in made) return made.outcome
				const field = pickWritableStringField(ctx, made.scratch.record)
				const value = field === null ? undefined : changedValue(ctx, field, made.scratch.record[field], updateOp)
				if (field !== null && value !== undefined) {
					const update = await updateRequest(ctx, updateOp, made.scratch.record, { [field]: value })
					const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
					const updated = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
						...update.options,
						headers: actor.headers(),
						operationId: updateOp.operationId,
					})
					note("update", actor, judge(updated))
				}
			}
			const deleteOp = ctx.deleteOp
			if (deleteOp !== undefined) {
				const made = await scratchRecord(ctx, this.id)
				if ("outcome" in made) return made.outcome
				const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
				const deleted = await ctx.client.request("DELETE", fillPath(deleteOp.path, params), {
					headers: actor.headers(),
					operationId: deleteOp.operationId,
				})
				note("delete", actor, judge(deleted))
			}
		}

		for (const [kind, verdicts] of writes) {
			for (const lower of home) {
				for (const higher of home) {
					if (lower.rank >= higher.rank) continue
					const lo = verdicts.get(lower.id)
					const hi = verdicts.get(higher.id)
					if (lo?.allowed !== true || hi?.allowed !== false) continue
					return ctx.findings.backend(
						this.id,
						ctx.entityName,
						`a lower-ranked role can ${kind} where a higher-ranked role cannot`,
						`${lower.role ?? lower.id} (rank ${lower.rank}) was allowed to ${kind} ${ctx.entityName} ` +
							`(${lo.exchange.status}); ${higher.role ?? higher.id} (rank ${higher.rank}) was refused ` +
							`(${hi.exchange.status}). Privilege must be monotonic on writes as on reads.`,
						[lo.exchange, hi.exchange],
					)
				}
			}
		}
		return ASSERTED
	},
}

/**
 * A query parameter the API does not know is either refused or ignored — consistently.
 *
 * Both are defensible policies, and the document rarely says which. What is not defensible is a
 * name nobody declared changing the result: a caller who misspells `limit` gets a different set
 * and no error. Two invented names are sent — one plain, one shaped like a real parameter with a
 * typo — and each answer compared, as a whole set, with the listing asked for without it.
 */
const unknownParameterConsistent: Check<{ names: string[] }> = {
	plan: (ctx) => {
		if (ctx.records.length === 0) return cannot()
		const real = conv(ctx).limit ?? conv(ctx).page ?? conv(ctx).order ?? "limit"
		return ready({ names: ["oat_unknown_parameter", `${real}_oat_typo`] })
	},
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	id: "query.unknown-parameter-consistent",
	needs: "a listing and at least one record",
	subjects: subjectsOf.list,
	async run(ctx, { names }): Promise<Outcome> {
		const baseline = await readSet(ctx, {}, { fresh: true })
		if (baseline.status !== "ok" || !baseline.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				baseline.reason ?? "the plain listing could not be read whole",
			)
		}
		const expected = setOf(baseline.items, ctx.identity)
		const answers: Array<{ name: string; policy: "refused" | "ignored"; exchange: Exchange }> = []
		for (const name of names) {
			const probe = await readSet(asProbe(ctx), { [name]: "1" }, { fresh: true })
			const exchange = probe.last.exchange
			if (exchange.status >= 500) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an unknown query parameter crashes the listing",
					`adding ?${name}=1, a parameter the document does not declare, returned ${exchange.status}.`,
					[exchange],
				)
			}
			if (exchange.status === 400 || exchange.status === 422) {
				answers.push({ exchange, name, policy: "refused" })
				continue
			}
			if (probe.status !== "ok" || !probe.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					`?${name}=1 was answered with ${exchange.status}, which says nothing about the parameter`,
				)
			}
			if (!sameSet(setOf(probe.items, ctx.identity), expected)) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an unknown query parameter silently changes the result",
					`adding ?${name}=1, a parameter the document does not declare, returned ${probe.items.length} ` +
						`record(s) where the plain listing returns ${expected.size}, with no error. A caller who ` +
						"misspells a parameter gets a different answer and no way to know.",
					[baseline.last.exchange, exchange],
				)
			}
			answers.push({ exchange, name, policy: "ignored" })
		}
		const policies = new Set(answers.map((answer) => answer.policy))
		if (policies.size > 1) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown query parameters are handled inconsistently",
				answers.map((answer) => `?${answer.name}=1 was ${answer.policy} (${answer.exchange.status})`).join("; ") +
					". One unknown name refused and another ignored leaves callers guessing which mistakes are caught.",
				answers.map((answer) => answer.exchange),
			)
		}
		return asserted(`unknown query parameters are ${answers[0]?.policy ?? "ignored"} on the listing`)
	},
}

/**
 * Paging parameters at and past their bounds: a page size of zero, a negative one, one that is
 * not a whole number, and a page past the end of the collection.
 *
 * Refusing an out-of-range size and serving a sane one are both fine; crashing is not. A page
 * past the end must hold nothing — a server that serves the last page again there makes every
 * client that pages until an empty page loop forever.
 */
const paginationBoundsHandled: Check<{ limit: string | undefined; page: string | undefined }> = {
	plan: (ctx) => {
		const { limit, page } = conv(ctx)
		if ((limit === undefined && page === undefined) || ctx.records.length === 0) return cannot()
		return ready({ limit, page })
	},
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	id: "pagination.bounds-handled",
	needs: "a page-size or page-number parameter, and at least one record",
	subjects: subjectsOf.list,
	async run(ctx, { limit, page }): Promise<Outcome> {
		if (limit !== undefined) {
			for (const value of ["0", "-1", "2.5", "abc"]) {
				const result = await list(asProbe(ctx), { [limit]: value })
				if (result.exchange.status >= 500) {
					return ctx.findings.backend(
						this.id,
						ctx.entityName,
						`a page size of ${value} crashes the listing`,
						`?${limit}=${value} returned ${result.exchange.status}; an out-of-range page size must be ` +
							"refused with a 4xx, or served as a sane size.",
						[result.exchange],
					)
				}
			}
		}
		if (page === undefined) return ASSERTED
		const whole = await readSet(ctx, {}, { fresh: true })
		if (whole.status !== "ok" || !whole.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, whole.reason ?? "the listing could not be read whole")
		}
		const size = pageSize(ctx)
		/* Past the end at any page size a server may serve — it may clamp below the size asked for,
		 * so a page number from the requested size could still fall inside the set. */
		const beyond = whole.items.length + 2
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: size }), [page]: beyond })
		const status = result.exchange.status
		if (status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"a page past the end crashes the listing",
				`?${page}=${beyond}, past the last of ${whole.items.length} record(s), returned ${status}.`,
				[result.exchange],
			)
		}
		if (status >= 400) return asserted(`a page past the end is refused (${status})`)
		if (result.items.length === 0) return asserted("a page past the end is served empty")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a page past the end of the collection returns records",
			`?${page}=${beyond} lies past the last of ${whole.items.length} record(s) at ${size} per page, ` +
				`yet returned ${result.items.length}. A client that pages until an empty page never stops.`,
			[whole.last.exchange, result.exchange],
		)
	},
}

/**
 * A child collection is reached only through parents the caller owns.
 *
 * The tenant root in a path is checked against the caller; the parents beneath it often are not.
 * Another tenant's parent id placed under the caller's own root — `/projects/mine/tables/{theirs}/
 * rows` — must be as unknown as a parent that never existed. Reading the children through it, or
 * writing a child under it, crosses the boundary one level down from where it is usually guarded.
 */
const foreignParentRejected: Check<{
	altAuth: () => Record<string, string>
	mixed: Record<string, string>
	tenantParam: string
	parents: string[]
}> = {
	plan: (ctx) => {
		const { altAuth, altScope } = ctx
		const tenantParam = ctx.listOp.tenantParam ?? undefined
		if (altAuth === undefined || altScope === undefined || tenantParam === undefined) return cannot()
		if (!tenantBoundary(ctx.listOp) || altScope[tenantParam] === undefined) return cannot()
		if (altScope[tenantParam] === ctx.scope[tenantParam]) return cannot()
		const parents = ctx.listOp.pathParams.filter((param) => param !== tenantParam && ctx.scope[param] !== undefined)
		if (parents.length === 0) return cannot("a parent below the tenant in the collection's path")
		/* The owner's parents, under the other tenant's root. */
		const mixed = { ...ctx.scope, [tenantParam]: altScope[tenantParam] as string }
		return ready({ altAuth, mixed, parents, tenantParam })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "tenant.parent-not-reachable-from-another-root",
	mutates: true,
	needs: "a second tenant, and a collection nested under a parent below the tenant",
	subjects: (entity) => declared(entity.list, entity.read, entity.create),
	async run(ctx, { altAuth, mixed, parents, tenantParam }): Promise<Outcome> {
		const path = `${ctx.listOp.path} with another tenant's ${parents.join(", ")} under its own ${tenantParam}`
		const breach = (summary: string, detail: string, evidence: Exchange[]): Outcome =>
			ctx.listOp.tenantSource === "tag"
				? ctx.findings.security(this.id, ctx.entityName, summary, detail, evidence)
				: ctx.findings.report({
						check: this.id,
						detail: `${detail} oat inferred the tenant from "${tenantParam}"; declare x-tenant to make this SECURITY.`,
						entity: ctx.entityName,
						evidence,
						summary,
						verdict: "AMBIGUITY",
					})
		const owned = setOf(ctx.records, ctx.identity)

		const listed = await list(ctx, q(ctx, { limit: pageSize(ctx) }), altAuth, mixed)
		if (listed.exchange.status < 300 && ids(listed.items, ctx.identity).some((id) => owned.has(id))) {
			return breach(
				"another tenant's records are listed through their parent under one's own root",
				`${path} listed ${listed.items.length} record(s), including the owner's.`,
				[listed.exchange],
			)
		}
		const target = ctx.records[0]
		if (ctx.readOp !== undefined && target !== undefined) {
			const read = await ctx.client.get(
				fillPath(ctx.readOp.path, { ...mixed, ...itemParamFor(ctx, String(target[ctx.identity])) }),
				{ headers: altAuth() },
			)
			if (read.status < 300) {
				return breach(
					"another tenant's record is readable through its parent under one's own root",
					`${path} read ${ctx.entityName} ${String(target[ctx.identity])} (${read.status}).`,
					[read],
				)
			}
		}
		const createOp = ctx.createOp
		const schema = createOp === undefined ? null : requestSchemaOf(ctx, createOp)
		if (createOp !== undefined && schema !== null) {
			const created = await ctx.client.request("POST", fillPath(createOp.path, mixed), {
				...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
				headers: altAuth(),
				operationId: createOp.operationId,
			})
			if (created.status < 300) {
				return breach(
					"a child can be created under another tenant's parent",
					`${path} accepted a create (${created.status}): a record now hangs off a parent the creator ` +
						"cannot otherwise see.",
					[created],
				)
			}
		}
		return ASSERTED
	},
}

const crossTenantFilterBypass: Check<{
	id: string
	tenantTerm: Record<string, string>
	altAuth: () => Record<string, string>
	altScope: Record<string, string>
}> = {
	plan: (ctx) => {
		const { altAuth, altScope } = ctx
		const target = ctx.records[0]
		if (altAuth === undefined || altScope === undefined || target === undefined) return cannot()
		if (!filterable(ctx) || !tenantBoundary(ctx.listOp) || !identityIsFilterable(ctx)) return cannot()
		const id = String(target[ctx.identity])
		const tenantTerm = filterTerm(conv(ctx), filterIdentity(ctx), "eq", id)
		if (tenantTerm === null) return cannot("a filter grammar that can express equality on the identity")
		return ready({ altAuth, altScope, id, tenantTerm })
	},
	/* The probe filters, so anything that stops a filter from selecting over the whole collection
	 * hides the very record whose visibility is in question — a leak that cannot be observed is
	 * not a leak that can be reported. */
	dependsOn: ["query.filter-selects-from-whole-set"],
	id: "tenant.filter-does-not-bypass-scope",
	needs: "a second principal, a filter, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.list,
	async run(ctx, { altAuth, altScope, id, tenantTerm }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...tenantTerm }, altAuth, altScope)
		if (result.exchange.status >= 400) return ASSERTED
		if (!ids(result.items, ctx.identity).includes(id)) return ASSERTED

		/* Same split as the item check. A public catalogue has no tenant at all — a 200 for
		 * `id.eq.<someone else's public row>` is the contract, not a leak. */
		const declared = ctx.listOp.tenantSource === "tag"
		const detail =
			`a principal in another tenant filtered on ${ctx.identity}.eq.${id} and received the ` +
			"record. The tenant predicate is applied to the base listing but not re-applied to " +
			"filter matches, so any caller who can guess an id can read it."

		if (declared) {
			return ctx.findings.security(
				this.id,
				ctx.entityName,
				"a filter reaches records outside the caller's tenant",
				`${detail} The list declares x-tenant: "${ctx.listOp.tenantParam}", so this crosses ` +
					"a boundary the document states exists.",
				[result.exchange],
			)
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${ctx.listOp.tenantParam}" path ` +
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
			entity: ctx.entityName,
			evidence: [result.exchange],
			summary: "a filter crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
		return ASSERTED
	},
}

function sameTenantScope(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
	if (keys.length === 0) return true
	return keys.every((key) => a[key] === b[key])
}

/**
 * Privilege must be monotonic in rank: anything a lower-ranked role can do, a higher-ranked
 * role in the same tenant must also be able to do.
 *
 * The oracle needs no ground truth about what "owner" means. Two principals, same tenant,
 * different ranks, one item. If the lower one is served and the higher one is denied, the
 * lattice is upside down — the failure mode of every hand-rolled role table that inverted
 * a comparison or attached the wrong policy to a name.
 */
const rankIsMonotonic: Check<{ id: string; readOp: OperationModel; home: Actor[] }> = {
	plan: (ctx) => {
		const target = ctx.records[0]
		const primary = ctx.actors[0]
		const readOp = ctx.readOp
		if (readOp === undefined || target === undefined || primary === undefined) return cannot()
		const home = ctx.actors.filter((actor) => sameTenantScope(actor.roots, primary.roots))
		if (new Set(home.map((actor) => actor.rank)).size < 2) return cannot()
		return ready({ home, id: String(target[ctx.identity]), readOp })
	},
	dependsOn: ["list.read-after-write"],
	id: "auth.rank-is-monotonic",
	needs: "two same-tenant principals at different ranks, and an item route",
	subjects: subjectsOf.read,
	async run(ctx, { home, id, readOp }): Promise<Outcome> {
		const seen = new Map<string, Exchange>()
		const probe = async (actor: Actor): Promise<"allow" | "deny" | "error"> => {
			/* Tenant from the actor; remaining path params (parent ids) from the seeded scope. */
			const params = { ...ctx.scope, ...actor.roots, ...itemParamFor(ctx, id) }
			const exchange = await ctx.client.get(fillPath(readOp.path, params), {
				headers: actor.headers(),
			})
			seen.set(actor.id, exchange)
			if (exchange.status < 300) return "allow"
			if (exchange.status === 403 || exchange.status === 404) return "deny"
			return "error"
		}

		const outcomes = new Map<string, "allow" | "deny" | "error">()
		for (const actor of home) {
			outcomes.set(actor.id, await probe(actor))
		}

		for (const lower of home) {
			for (const higher of home) {
				if (lower.rank >= higher.rank) continue
				const lo = outcomes.get(lower.id)
				const hi = outcomes.get(higher.id)
				if (lo !== "allow" || hi !== "deny") continue
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a lower-ranked role can read a record a higher-ranked role cannot",
					`${lower.role ?? lower.id} (rank ${lower.rank}) was served ${ctx.entityName} ${id}; ` +
						`${higher.role ?? higher.id} (rank ${higher.rank}) was denied. Privilege must be ` +
						"monotonic — a member who can see what an owner cannot is the lattice inverted, " +
						"not a finer policy.",
					[seen.get(lower.id), seen.get(higher.id)].filter((exchange) => exchange !== undefined),
				)
			}
		}
		return ASSERTED
	},
}

function pointerValue(body: unknown, pointer: string): string | undefined {
	const node = readPath(body, pointer)
	/* Grant and job ids are as often numbers as strings. */
	if (typeof node === "number" && Number.isFinite(node)) return String(node)
	return typeof node === "string" && node !== "" ? node : undefined
}

/**
 * Delegated access is a flow, not a request: B cannot read A's record, A invites B, B accepts,
 * B can read, A revokes, B cannot. Each step is a capability statement the next one depends on.
 * A grant that appears before accept, never appears, or survives revoke is a different bug
 * at the same check — the timeline is the property.
 */
const inviteGrantsThenRevokes: Check<{
	spec: InviteSpec
	owner: Actor
	delegate: Actor
	inviteAs: string
	inviteOp: OperationModel
	acceptOp: OperationModel
	revokeOp: OperationModel
}> = {
	mutates: true,
	plan: (ctx) => {
		const spec = ctx.invite
		const owner = ctx.actors[0]
		if (spec === null || owner === undefined) return cannot()
		const delegate =
			ctx.actors.find(
				(actor) => actor !== owner && actor.inviteAs !== undefined && !sameTenantScope(actor.roots, owner.roots),
			) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
		if (delegate?.inviteAs === undefined) {
			return cannot("a peer principal declaring inviteAs, so the grantee field need not be invented")
		}
		const inviteOp = ctx.model.byOperationId.get(spec.invite)
		const acceptOp = ctx.model.byOperationId.get(spec.accept)
		const revokeOp = ctx.model.byOperationId.get(spec.revoke)
		if (inviteOp === undefined || acceptOp === undefined || revokeOp === undefined) {
			return cannot("x-invite operations that exist in the document")
		}
		return ready({ acceptOp, delegate, inviteAs: delegate.inviteAs, inviteOp, owner, revokeOp, spec })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "auth.invite-grants-then-revokes",
	needs: "x-invite naming invite/accept/revoke, a peer principal with inviteAs, and an item or list route",
	subjects: subjectsOf.invite,
	async run(ctx, { acceptOp, delegate, inviteAs, inviteOp, owner, revokeOp, spec }): Promise<Outcome> {
		const target = ctx.records[0]
		const id = target === undefined ? undefined : String(target[ctx.identity])
		const resource = {
			...ctx.scope,
			...(id === undefined ? {} : itemParamFor(ctx, id)),
		}

		const itemPath = ctx.readOp?.path
		const canRead = async (): Promise<boolean | null> => {
			if (itemPath === undefined || id === undefined) return null
			const exchange = await ctx.client.get(fillPath(itemPath, { ...delegate.roots, ...resource }), {
				headers: delegate.headers(),
			})
			return exchange.status < 300
		}

		const alreadyReadable = await canRead()
		if (alreadyReadable === true) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the delegate could already read the record, so invite cannot be distinguished from a leak",
			)
		}

		const invited = await ctx.client.request(inviteOp.method, fillPath(inviteOp.path, resource), {
			body: { [spec.granteeField]: inviteAs },
			headers: { ...owner.headers(), "content-type": "application/json" },
			operationId: inviteOp.operationId,
		})
		if (standDownForFeatureGate(ctx, inviteOp, invited, this.id))
			return standDown("a documented feature gate refused the request")
		if (invited.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`invite returned ${invited.status}, so accept/revoke were never exercised`,
			)
		}
		const grantId = pointerValue(invited.responseBody, spec.grantPointer)
		let token: string | undefined
		let revokedAlready = false
		const revoke = async (grant: string): Promise<Exchange> => {
			revokedAlready = true
			const revokeScope = { ...resource, grant_id: grant, ...(token === undefined ? {} : { token }) }
			const revokeBody = documentedJsonBody(ctx, revokeOp, revokeScope)
			return ctx.client.request(revokeOp.method, fillPath(revokeOp.path, revokeScope), {
				...(revokeBody === undefined ? {} : { body: revokeBody }),
				headers: {
					...owner.headers(),
					...(revokeBody === undefined ? {} : { "content-type": "application/json" }),
				},
				operationId: revokeOp.operationId,
			})
		}
		/* From here a grant exists, accepted or not. Whatever this check concludes, the access it
		 * handed out is taken back before it returns. */
		try {
			if ((await canRead()) === true) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an invite grants access before it is accepted",
					`inviting ${delegate.id} made ${ctx.entityName} ${id} readable immediately. The accept ` +
						"step is then theatre — anyone who can be named in an invite body is already in.",
					[invited],
				)
			}

			if (spec.tokenFrom === "outOfBand") {
				const kind = spec.tokenKind ?? `${ctx.entityName}-invite`
				try {
					token = await resolveOutOfBandValue(ctx.hooks.resolveOutOfBand, inviteAs, kind, {
						headers: delegate.headers(),
						label: `invite to ${ctx.entityName}`,
						outOfBand: ctx.outOfBand,
						scope: { ...resource, inviteAs },
					})
				} catch (error) {
					return ctx.findings.unresolved(
						this.id,
						ctx.entityName,
						error instanceof Error ? error.message : String(error),
					)
				}
			} else {
				token = pointerValue(invited.responseBody, spec.tokenPointer)
				if (token === undefined) {
					return ctx.findings.unresolved(
						this.id,
						ctx.entityName,
						`invite response has no token at ${spec.tokenPointer}`,
					)
				}
			}

			const acceptScope = { ...resource, token }
			let accepted: Exchange
			if (spec.acceptFrom === "link") {
				if (!isAbsoluteHttpUrl(token)) {
					return ctx.findings.unresolved(
						this.id,
						ctx.entityName,
						`x-invite.acceptFrom: link needs an absolute http(s) URL, got ${JSON.stringify(token)}`,
					)
				}
				accepted = await ctx.client.request("GET", token, {
					headers: delegate.headers(),
					redirect: "follow",
				})
			} else {
				const acceptBody = documentedJsonBody(ctx, acceptOp, acceptScope)
				accepted = await ctx.client.request(acceptOp.method, fillPath(acceptOp.path, acceptScope), {
					...(acceptBody === undefined ? {} : { body: acceptBody }),
					headers: {
						...delegate.headers(),
						...(acceptBody === undefined ? {} : { "content-type": "application/json" }),
					},
					operationId: acceptOp.operationId,
				})
			}
			if (spec.acceptFrom !== "link" && standDownForFeatureGate(ctx, acceptOp, accepted, this.id))
				return standDown("a documented feature gate refused the request")
			const acceptFailed = spec.acceptFrom === "link" ? accepted.status >= 400 : accepted.status >= 300
			if (acceptFailed) {
				return ctx.findings.unresolved(this.id, ctx.entityName, `accept returned ${accepted.status}`)
			}
			const issued = pointerValue(accepted.responseBody, spec.credentialFrom)
			if (issued !== undefined) delegate.adoptCredential?.(issued)
			if ((await canRead()) === false) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"accepting an invite does not grant access",
					`${delegate.id} accepted an invite to ${ctx.entityName} ${id} and still cannot read it. ` +
						"The invite flow completed; the grant did not.",
					[invited, accepted],
				)
			}

			if (grantId === undefined) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					`invite response has no grant id at ${spec.grantPointer}, so revoke cannot be expressed`,
				)
			}
			const revoked = await revoke(grantId)
			if (standDownForFeatureGate(ctx, revokeOp, revoked, this.id))
				return standDown("a documented feature gate refused the request")
			if (revoked.status >= 300) {
				return ctx.findings.unresolved(this.id, ctx.entityName, `revoke returned ${revoked.status}`)
			}
			if ((await canRead()) === true) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"revoking an invite does not remove access",
					`${delegate.id} can still read ${ctx.entityName} ${id} after the grant was revoked. ` +
						"A share that cannot be taken back is a standing leak.",
					[invited, accepted, revoked],
				)
			}
			return ASSERTED
		} finally {
			if (!revokedAlready && grantId !== undefined) await revoke(grantId).catch(() => undefined)
		}
	},
}

const malformedFilterNot5xx: Check = {
	plan: (ctx) => when(filterable(ctx)),
	id: "error.malformed-filter-not-5xx",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(asProbe(ctx), q(ctx, { filter: "((((", limit: 10 }))
		if (result.exchange.status < 500) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"malformed filter input produces a server error",
			`a syntactically invalid filter returned ${result.exchange.status}. Bad client input must ` +
				"be rejected with a 4xx; a 5xx means the parser is throwing rather than validating.",
			[result.exchange],
		)
	},
}

const limitBoundsPageSize: Check = {
	plan: (ctx) => when(conv(ctx).limit !== undefined && ctx.records.length > 2),
	dependsOn: ["list.read-after-write"],
	id: "pagination.limit-bounds-page-size",
	needs: "a page-size query parameter named `limit`",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(ctx, q(ctx, { limit: 2 }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing was rejected")
		if (result.items.length <= 2) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"limit does not bound the number of records returned",
			`limit=2 returned ${result.items.length} records. A page size the backend accepts and ` +
				"ignores means callers cannot bound response size, and every paging loop is wrong.",
			[result.exchange],
		)
	},
}

const limitRespectsMax: Check<{ max: number; limitParam: string }> = {
	plan: (ctx) => {
		const max = ctx.query?.maxLimit
		const limitParam = conv(ctx).limit
		/* Unless the collection holds more records than the cap, an uncapped backend and a
		 * capped one return the same thing and the check would prove nothing. */
		if (max === undefined || limitParam === undefined || ctx.records.length <= max) return cannot()
		return ready({ limitParam, max })
	},
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.limit-respects-documented-max",
	needs: "a declared maxLimit, and more records than it",
	subjects: subjectsOf.list,
	async run(ctx, { limitParam, max }): Promise<Outcome> {
		/* Deliberately past the cap — the one request that may break the documented bound. */
		const result = await list(asProbe(ctx), { [limitParam]: max + 50 })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		if (result.items.length <= max) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"page size exceeds the documented maximum",
			`limit=${max + 50} returned ${result.items.length} records; the document caps limit at ` +
				`${max}. Either the cap is not enforced or the document overstates it.`,
			[result.exchange],
		)
	},
}

const hasMoreIsAccurate: Check = {
	plan: (ctx) => when(pageable(ctx) && ctx.records.length > 2),
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.has-more-is-accurate",
	needs: "a way to page forward, and a more-pages signal in the body or a Link header",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const first = await list(ctx, q(ctx, { limit: 1, page: 1 }))
		if (first.exchange.status >= 400 || first.items.length === 0)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the first page was rejected or empty")
		const flag = envelopeValue(ctx, first, "hasMore")
		if (typeof flag !== "boolean") return standDown("the listing has no has-more flag")

		const second = await list(ctx, q(ctx, { limit: 1, page: 2 }))
		const moreExist = second.items.length > 0
		if (flag === moreExist) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			flag
				? "hasMore claims further pages exist when none do"
				: "hasMore claims no further pages while the next page returns records",
			`page 1 at limit=1 reported hasMore=${flag}, but page 2 returned ` +
				`${second.items.length} record(s). Callers that trust the flag will ` +
				(flag ? "request an empty page" : "silently stop after the first page"),
			[first.exchange, second.exchange],
		)
	},
}

const orderChangesResult: Check<{ field: string }> = {
	plan: (ctx) => {
		const field = ctx.query?.sortable.find((f) => f !== ctx.identity) ?? ctx.query?.sortable[0]
		return field === undefined || ctx.records.length <= 2 ? cannot() : ready({ field })
	},
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "sort.order-is-applied",
	needs: "an `order` parameter and a sortable field",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const ascending = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
		if (ascending.exchange.status >= 400 || ascending.items.length < 2)
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the sorted listing was rejected or held fewer than two records",
			)

		const values = ascending.items.map((item) => item[field])
		if (values.some((value) => value === undefined))
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sort field is absent from the listed records")
		const order = sortedUnder(ctx, field, values)
		if (order !== null) {
			/* An ignored order can come back ascending by accident — a server's own tiebreak on
			 * this very field does it — but not ascending and descending at once. */
			const descending = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "desc") }))
			const reversed = descending.items.map((item) => item[field])
			const distinct = new Set(values.map((value) => JSON.stringify(value))).size
			if (descending.exchange.status < 400 && distinct > 1 && JSON.stringify(reversed) === JSON.stringify(values)) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"order is accepted but has no effect",
					`order=${field}.asc and order=${field}.desc returned the same sequence of "${field}" ` +
						"values. The listing comes back in one fixed order whatever is asked for.",
					[ascending.exchange, descending.exchange],
				)
			}
			observeTextOrder(ctx, field, order, values)
			return ASSERTED
		}

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"order is accepted but the result is not sorted",
			`order=${field}.asc returned records whose "${field}" values are not ascending: ` +
				`${values
					.slice(0, 5)
					.map((v) => JSON.stringify(v))
					.join(", ")}. A sort parameter the ` +
				"backend ignores silently gives every caller arbitrary ordering.",
			[ascending.exchange],
		)
	},
}

function numericLexicalDisagrees(ctx: CheckContext, field: string): boolean {
	return cohortFact(ctx, `numeric-lexical:${field}`, () => computeNumericLexicalDisagrees(ctx, field))
}

function computeNumericLexicalDisagrees(ctx: CheckContext, field: string): boolean {
	const values = ctx.records.map((row) => row[field]).filter((v): v is number => typeof v === "number")
	if (values.length < 3) return false
	const unique = [...new Set(values)]
	const asNumbers = [...unique].sort((a, b) => a - b)
	const asText = [...unique].sort((a, b) => String(a).localeCompare(String(b)))
	return asNumbers.join(",") !== asText.join(",")
}

/** Numbers numerically, everything else by its text — the one ordering every collation shares on ids. */
function compareScalars(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

/**
 * The ways a backend may order text. oat cannot know a backend's collation, so an order is
 * judged sorted when it is sorted under one of these — and, once the backend has shown which,
 * under that one from then on.
 */
const TEXT_ORDERS = {
	binary: (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0),
	folded: (a: string, b: string): number => {
		const x = a.toLowerCase()
		const y = b.toLowerCase()
		return x < y ? -1 : x > y ? 1 : 0
	},
	locale: (a: string, b: string): number => a.localeCompare(b),
} as const

type TextOrder = keyof typeof TEXT_ORDERS

const DECLARED_TEXT_ORDER = { binary: "binary", "case-insensitive": "folded", locale: "locale" } as const

/** How the backend has shown it orders each sort field: its text order and where nulls go. */
interface ObservedOrder {
	text: TextOrder
	nulls?: "first" | "last"
}

/** Orders each entity's backend has shown, by sort field. */
const observedTextOrders = new WeakMap<readonly Record_[], Map<string, ObservedOrder>>()

/**
 * The text order under which `values` — one sort field, in the order the backend returned them,
 * ascending — are sorted, or `null` when they are sorted under none.
 *
 * Collation-independent by construction: numbers must ascend numerically whatever the text
 * order, nulls must sit together at one end, and ties may come in any order. Text is held to the
 * order the backend already showed for this field when there is one, else to any of them.
 */
function sortedUnder(ctx: CheckContext, field: string, values: readonly unknown[]): TextOrder | null {
	const isNull = (value: unknown): boolean => value === null || value === undefined
	const present = values.filter((value) => !isNull(value))
	const nulls = values.length - present.length
	const declared = resolvedCaps(ctx).sort
	const observed = observedTextOrders.get(ctx.records)?.get(field)
	const known: ObservedOrder | undefined =
		declared?.collation === undefined && declared?.defaultNulls === undefined
			? observed
			: {
					text:
						declared.collation === undefined ? (observed?.text ?? "binary") : DECLARED_TEXT_ORDER[declared.collation],
					...(declared.defaultNulls === undefined ? {} : { nulls: declared.defaultNulls }),
				}
	if (nulls > 0 && present.length > 0) {
		/* Nulls together at one end — and the same end every time once one has been seen. */
		const first = values.slice(0, nulls).every(isNull)
		const last = values.slice(present.length).every(isNull)
		if (!first && !last) return null
		if (known?.nulls === "first" && !first) return null
		if (known?.nulls === "last" && !last) return null
	}
	const candidates: TextOrder[] =
		known === undefined || (declared?.collation === undefined && observed === undefined)
			? ["binary", "folded", "locale"]
			: [known.text]
	for (const order of candidates) {
		const text = TEXT_ORDERS[order]
		const ascending = present.every((value, index) => {
			if (index === 0) return true
			const prior = present[index - 1]
			if (typeof prior === "number" && typeof value === "number") return prior <= value
			return text(String(prior), String(value)) <= 0
		})
		if (ascending) return order
	}
	return null
}

/** Records how the backend ordered `field`, so later checks hold it to the same order. */
function observeTextOrder(ctx: CheckContext, field: string, text: TextOrder, values: readonly unknown[]): void {
	const orders = observedTextOrders.get(ctx.records) ?? new Map<string, ObservedOrder>()
	observedTextOrders.set(ctx.records, orders)
	if (orders.has(field)) return
	const isNull = (value: unknown): boolean => value === null || value === undefined
	const nulls =
		values.some(isNull) && values.some((value) => !isNull(value))
			? isNull(values[0])
				? ("first" as const)
				: ("last" as const)
			: undefined
	orders.set(field, nulls === undefined ? { text } : { nulls, text })
}

const searchNarrowsResult: Check<{ field: string }> = {
	plan: (ctx) => {
		const field = ctx.query?.searchable[0]
		return conv(ctx).search === undefined || field === undefined || ctx.records.length <= 2
			? cannot()
			: ready({ field })
	},
	dependsOn: ["list.read-after-write"],
	id: "search.q-narrows-result",
	needs: "a free-text `q` parameter and declared searchable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await list(ctx, q(ctx, { limit }))
		if (all.items.length < 2)
			return ctx.findings.unresolved(this.id, ctx.entityName, "fewer than two records to narrow")

		/* A token no record can contain: a correct search returns nothing. */
		const result = await list(ctx, q(ctx, { limit, search: "zzqqxx-oat-no-match-token" }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the search was rejected")
		if (result.items.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"free-text search returns records that cannot match",
			`q= a token no record contains returned ${result.items.length} of ${all.items.length} ` +
				"records, so the search term is being ignored rather than applied.",
			[all.exchange, result.exchange],
		)
	},
}

const createPersistsFields: Check<{ createOp: OperationModel; properties: Record<string, Record<string, unknown>> }> = {
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined || ctx.records.length === 0) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
		return ready({ createOp, properties })
	},
	dependsOn: ["list.read-after-write"],
	id: "create.persists-submitted-fields",
	judgesTranscript: true,
	needs: "a create operation that echoes the record back",
	subjects: subjectsOf.create,
	async run(ctx, { properties }): Promise<Outcome> {
		const sent = await createExchange(ctx)
		if (sent === undefined || sent.requestBody === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no create request body was observed")
		const form = formValues(sent.requestBody, headerValue(sent.requestHeaders, "content-type"))
		const request: Record_ =
			form === null
				? submittedFields(sent.requestBody)
				: Object.fromEntries([...form].map(([key, values]) => [key, coerceFormValue(values, properties[key])]))
		if (Object.keys(request).length === 0) return standDown("the create body was empty")
		const response = (sent.responseBody ?? {}) as Record_

		const dropped = Object.entries(request).filter(([key, value]) => {
			if (value === null || value === undefined) return false
			/* A writeOnly field is accepted and never returned — a password, a secret. */
			if (properties[key]?.writeOnly === true) return false
			if (!Object.hasOwn(response, key)) return true
			return JSON.stringify(response[key]) !== JSON.stringify(value)
		})
		if (dropped.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"create silently discards submitted fields",
			`the create response does not carry back ${dropped.length} submitted field(s): ` +
				dropped
					.slice(0, 4)
					.map(([key, value]) => `${key} sent ${JSON.stringify(value)}, got ${JSON.stringify(response[key])}`)
					.join("; ") +
				". A write that reports success and drops data is worse than one that fails.",
			[sent],
		)
	},
}

const enumValidated: Check<CreateBody & { target: ConstrainedField }> = {
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const target = findConstrained(create.schema, (s) => Array.isArray(s.enum) && s.enum.length > 0)
			return target === null ? cannot("a request field that declares an enum") : ready({ ...create, target })
		}),
	mutates: true,
	id: "validation.enum-enforced",
	needs: "a request schema with an enum field",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema, target }): Promise<Outcome> {
		const outside = outsideEnum(target.schema)
		if (!outside.ok) return ctx.findings.unresolved(this.id, ctx.entityName, outside.reason)
		const body = { ...validBody(ctx, schema), [target.name]: outside.value }
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		const declared = (target.schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a value outside the declared enum was accepted",
			`"${target.name}" declares [${declared}] but the backend accepted ${JSON.stringify(outside.value)} ` +
				`with ${exchange.status}. Clients generated from this document will assume the field ` +
				"only ever holds a declared member.",
			[exchange],
		)
	},
}

const maxLengthValidated: Check<CreateBody & { target: ConstrainedField }> = {
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const target = findConstrained(
				create.schema,
				(s) => typeof s.maxLength === "number" && (s.maxLength as number) < 4096,
			)
			return target === null ? cannot("a request field that declares a maxLength") : ready({ ...create, target })
		}),
	mutates: true,
	id: "validation.max-length-enforced",
	needs: "a request schema with a maxLength constraint",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema, target }): Promise<Outcome> {
		const max = target.schema.maxLength as number
		const over = overMaxLength(target.schema)
		if (!over.ok) return standDown(over.reason)
		const value = over.value as string
		const body = { ...validBody(ctx, schema), [target.name]: value }
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a string longer than the declared maxLength was accepted",
			`"${target.name}" declares maxLength ${max} but a ${value.length}-character value was stored ` +
				`(${exchange.status}). The constraint exists in the document only.`,
			[exchange],
		)
	},
}

const requiredValidated: Check<CreateBody & { field: string }> = {
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const required = Array.isArray(create.schema.required) ? (create.schema.required as string[]) : []
			const field = required[0]
			return field === undefined ? cannot("a request body with a required field") : ready({ ...create, field })
		}),
	mutates: true,
	id: "validation.required-enforced",
	needs: "a request schema with a required field",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, field, schema }): Promise<Outcome> {
		const { [field]: _omitted, ...body } = validBody(ctx, schema)
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"create succeeded without a required field",
			`"${field}" is listed in the schema's required array, but omitting it returned ` +
				`${exchange.status}. Either the handler does not validate it or the document ` +
				"overstates the requirement.",
			[exchange],
		)
	},
}

const contentTypeEnforced: Check<CreateBody> = {
	plan: (ctx) =>
		ctx.createOp !== undefined && documentsStatus(ctx.createOp.statuses, 415) ? createBodyPlan(ctx) : cannot(),
	mutates: true,
	id: "validation.content-type-enforced",
	needs: "a documented 415 response",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema }): Promise<Outcome> {
		/* The body the endpoint would parse, under a label it does not accept: a server that skips
		 * the check must then process it, rather than refuse it for some unrelated reason. */
		const encoded = await encodeOpBody(ctx, createOp, validBody(ctx, schema))
		const raw = ctx.model.rawOperations.get(createOp.operationId)
		const declared =
			raw === undefined ? "a declared media type" : (requestContent(raw)?.mediaType ?? "a declared media type")
		const text =
			encoded.body instanceof URLSearchParams
				? encoded.body.toString()
				: typeof encoded.body === "string"
					? encoded.body
					: JSON.stringify(encoded.body)
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			body: text,
			contentType: "text/plain",
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["content-type"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a request labelled with an undeclared content type was processed",
			`the operation documents 415 and declares ${declared}, but the same body sent as ` +
				`text/plain was processed (${exchange.status}). Content negotiation is documented ` +
				"but not implemented.",
			[exchange],
		)
	},
}

const errorSchemaHonoured: Check<{ readOp: OperationModel; validator: SchemaValidator; raw: OperationObject }> = {
	plan: (ctx) => {
		const { readOp, validator } = ctx
		if (readOp === undefined || validator === undefined) return cannot()
		const raw = ctx.model.rawOperations.get(readOp.operationId)
		return raw === undefined ? cannot() : ready({ raw, readOp, validator })
	},
	id: "schema.error-response-matches-document",
	judgesTranscript: true,
	needs: "a documented error schema on the item route",
	subjects: (entity, model) => [
		...new Set([
			...subjectsOf.readAndGated(entity, model),
			...ownOps(entity, model, (op) => op.unique !== null && op.unique.length > 0),
		]),
	],
	async run(ctx, { raw, readOp, validator }): Promise<Outcome> {
		const judged: string[] = []
		if (graded(ctx, readOp)) {
			await probeMissingItemError(ctx, readOp, raw, validator, this.id)
			judged.push(readOp.operationId)
		}

		/* Expected refusals are coverage for the check that drew them, not for the error schema:
		 * a documented feature-gate 403 or a unique-conflict 409 still has to carry the body the
		 * document declares. Judged here, over everything this entity's run drew. */
		for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
			/* Error bodies are what this judges; one moved out of memory is read back. */
			const exchange = listed.status >= 400 ? await ctx.client.hydrate(listed) : listed
			if (exchange.superseded === true) continue
			const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
			if (op === undefined || op.entity !== ctx.entityName || !graded(ctx, op)) continue
			const gated = isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)
			const conflict = exchange.status === 409 && op.unique !== null && op.unique.length > 0
			if (!gated && !conflict) continue
			judged.push(op.operationId)
			errorBodyDrift(ctx.findings.attributed([op.operationId]), validator, op, ctx, exchange, this.id)
		}
		ctx.judged?.([...new Set(judged)])
		return ASSERTED
	},
}

/** Reports an error body that fails the schema its operation declares for that status. */
function errorBodyDrift(
	findings: CheckContext["findings"],
	validator: SchemaValidator,
	op: OperationModel,
	ctx: CheckContext,
	exchange: Exchange,
	check: string,
): void {
	const raw = ctx.model.rawOperations.get(op.operationId)
	if (raw === undefined || !validator.documents(raw, exchange.status)) return
	const result = validator.validate(op.operationId, raw, exchange.status, exchange.responseBody)
	if (result.unchecked !== undefined) {
		findings.gap(
			check,
			ctx.entityName,
			`${op.operationId} ${exchange.status} has a schema that cannot be compiled`,
			`AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
		)
		return
	}
	if (result.ok) return
	findings.spec(
		check,
		ctx.entityName,
		`${exchange.status} error body does not match its documented schema`,
		`${op.operationId} returned ${exchange.status} with a body that fails the schema the ` +
			`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
			"from the spec will not understand this response.",
		[exchange],
	)
}

async function probeMissingItemError(
	ctx: CheckContext,
	readOp: OperationModel,
	raw: OperationObject,
	validator: SchemaValidator,
	check: string,
): Promise<void> {
	const missing = absentId(ctx)
	if (missing === null) return
	const params = { ...ctx.scope, ...itemParamFor(ctx, missing) }
	const exchange = await asProbe(ctx).client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
	if (exchange.status < 400 || !validator.documents(raw, exchange.status)) return
	const result = validator.validate(readOp.operationId, raw, exchange.status, exchange.responseBody)
	if (result.unchecked !== undefined) {
		ctx.findings.gap(
			check,
			ctx.entityName,
			`${readOp.operationId} ${exchange.status} has a schema that cannot be compiled`,
			`AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
		)
		return
	}
	if (result.ok) return
	ctx.findings
		.attributed([readOp.operationId])
		.spec(
			check,
			ctx.entityName,
			`${exchange.status} error body does not match its documented schema`,
			`${readOp.operationId} returned ${exchange.status} with a body that fails the schema the ` +
				`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
				"from the spec will not understand this response.",
			[exchange],
		)
}

const successSchemaHonoured: Check<{ createOp: OperationModel; validator: SchemaValidator; raw: OperationObject }> = {
	plan: (ctx) => {
		const { createOp, validator } = ctx
		if (createOp === undefined || validator === undefined) return cannot()
		const raw = ctx.model.rawOperations.get(createOp.operationId)
		return raw === undefined ? cannot() : ready({ createOp, raw, validator })
	},
	/* The body is validated against the schema declared *for the status that came back*. When the
	 * status itself is undocumented there is no schema to validate against, and the right finding
	 * is the status one — not silence. */
	dependsOn: ["create.status-matches-document"],
	id: "schema.success-response-matches-document",
	judgesTranscript: true,
	needs: "a documented success schema on create",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, raw, validator }): Promise<Outcome> {
		const exchange = await createExchange(ctx)
		if (exchange === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no successful create was observed")
		if (isEventStream(exchange, createOp)) return standDown("the create answers with an event stream")
		if (!validator.documents(raw, exchange.status)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`create returned ${exchange.status}, which the document declares no schema for — ` +
					"there is nothing to validate the body against",
			)
		}

		const result = validator.validate(createOp.operationId, raw, exchange.status, exchange.responseBody)
		if (result.unchecked !== undefined) {
			return ctx.findings.gap(
				this.id,
				ctx.entityName,
				`${createOp.operationId} ${exchange.status} has a schema that cannot be compiled`,
				`AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
			)
		}
		if (result.ok) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"success response does not match its documented schema",
			`${createOp.operationId} returned ${exchange.status} with a body that fails the declared ` +
				`schema: ${result.errors.join("; ")}. Either the handler returns more than it promises ` +
				"or the document is out of date — both break generated clients.",
			[exchange],
		)
	},
}

/** Builds a body that should be accepted, for use as the base of a negative probe. */
function validBody(ctx: CheckContext, schema: Record<string, unknown>): Record<string, unknown> {
	const [member] = buildCohort(schema, ctx.seed, ["baseline"], ctx.createOp?.operationId ?? ctx.entityName, {
		defs: ctx.model.defs,
		distinct: new Set((ctx.uniqueSets ?? []).flat()),
		nonce: `${ctx.nonce}${ctx.client.transcript.length}`,
	})
	const body = member?.body ?? {}
	const sets = ctx.uniqueSets ?? []
	if (sets.length === 0) return body
	return uniquifyProbeBody(body, sets, schema, `p${ctx.nonce}x${ctx.client.transcript.length}`)
}

/** Invite bodies must carry the peer's `inviteAs`, never a generated email. */
function bodyForOp(ctx: CheckContext, op: OperationModel): Record<string, unknown> {
	const body = validBody(ctx, requestSchemaOf(ctx, op) ?? {})
	const spec = op.invite ?? ctx.invite
	if (spec === null || spec === undefined) return body
	const owner = ctx.actors[0]
	const delegate =
		ctx.actors.find(
			(actor) =>
				actor !== owner &&
				actor.inviteAs !== undefined &&
				owner !== undefined &&
				!sameTenantScope(actor.roots, owner.roots),
		) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
	if (delegate?.inviteAs !== undefined) body[spec.granteeField] = delegate.inviteAs
	return body
}

function subject(entity: string, operationId: string, fixture?: string): string {
	if (fixture === undefined) return entity
	return `${operationId} · ${fixture}`
}

function requestSchemaOf(ctx: CheckContext, op: OperationModel): Record<string, unknown> | null {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	return picked === null ? null : picked.schema
}

async function encodeOpBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, unknown>,
	variant = "baseline",
	index = 0,
	uploads: UploadContext = ctx.uploads,
): Promise<Pick<RequestOptions, "body" | "contentType">> {
	const encoded = await encodeForOperation(op, ctx.model, fields, uploads, variant, index)
	return encoded.contentType === undefined
		? { body: encoded.body }
		: { body: encoded.body, contentType: encoded.contentType }
}

/** A record created for one mutating check: what it holds, and the create that made it. */
interface Scratch {
	id: string
	record: Record_
	exchange: Exchange
}

/**
 * A record made for one mutating check, ledgered and removed with everything else the run made.
 *
 * Mutating checks write to this, never to the cohort. A cohort record a check has patched no
 * longer matches what every read-only oracle planned against, and a check that restores it
 * afterwards still leaves the window in between — and loses the restore whenever the write it
 * is probing was itself broken.
 */
async function scratchRecord(ctx: WriteContext, check: string): Promise<{ scratch: Scratch } | { outcome: Outcome }> {
	const createOp = ctx.createOp
	const schema = createOp === undefined ? null : requestSchemaOf(ctx, createOp)
	if (createOp === undefined || schema === null) {
		return { outcome: standDown("a create operation with a request body, to make a record this check may change") }
	}
	const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
		...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
		headers: ctx.auth(),
		operationId: createOp.operationId,
	})
	if (standDownForFeatureGate(ctx, createOp, exchange, check)) {
		return { outcome: standDown("a documented feature gate refused the request") }
	}
	const record = (exchange.responseBody ?? {}) as Record_
	const id = record[ctx.identity]
	if (exchange.status >= 300 || (typeof id !== "string" && typeof id !== "number")) {
		return {
			outcome: ctx.findings.unresolved(
				check,
				ctx.entityName,
				`a record for this check could not be made: the create answered ${exchange.status}` +
					(exchange.status < 300 ? ` without "${ctx.identity}"` : ""),
			),
		}
	}
	return { scratch: { exchange, id: String(id), record } }
}

/**
 * The request an update operation takes, in its own method: the changed fields alone for PATCH,
 * the whole representation with the changes applied for PUT — a PUT carrying one field would
 * replace the record with it.
 */
async function updateRequest(
	ctx: CheckContext,
	updateOp: OperationModel,
	current: Record_,
	changes: Record_,
): Promise<{ method: string; options: Pick<RequestOptions, "body" | "contentType"> }> {
	const method = updateOp.method.toUpperCase()
	if (method !== "PUT") return { method, options: await encodeOpBody(ctx, updateOp, changes) }
	const schema = requestSchemaOf(ctx, updateOp)
	const properties = Object.keys((schema?.properties ?? {}) as Record<string, unknown>)
	const kept = Object.fromEntries(
		properties.filter((key) => current[key] !== undefined).map((key) => [key, current[key]]),
	)
	const whole = { ...(schema === null ? {} : validBody(ctx, schema)), ...kept, ...changes }
	return { method, options: await encodeOpBody(ctx, updateOp, whole) }
}

/** Every value a form body carried, by field — repeated keys are how a form sends an array. */
function formValues(body: unknown, contentType?: string): Map<string, string[]> | null {
	const entries: Array<[string, string]> = []
	const urlencoded = contentType?.toLowerCase().includes("application/x-www-form-urlencoded") === true
	if (
		urlencoded &&
		body !== null &&
		typeof body === "object" &&
		!Array.isArray(body) &&
		!(body instanceof URLSearchParams)
	) {
		/* The transcript keeps a urlencoded body as its fields, repeated keys as arrays. */
		for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
			for (const item of [value].flat()) if (typeof item === "string") entries.push([name, item])
		}
	} else if (typeof FormData !== "undefined" && body instanceof FormData) {
		for (const [name, value] of body.entries()) if (typeof value === "string") entries.push([name, value])
	} else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		entries.push(...body.entries())
	} else if (body !== null && typeof body === "object" && Array.isArray((body as { parts?: unknown }).parts)) {
		for (const part of (body as { parts: Array<Record<string, unknown>> }).parts) {
			if (typeof part.field === "string" && typeof part.value === "string") entries.push([part.field, part.value])
		}
	} else {
		return null
	}
	const out = new Map<string, string[]>()
	for (const [name, value] of entries) out.set(name, [...(out.get(name) ?? []), value])
	return out
}

/**
 * What a form-submitted field means once the property type is applied: the record stores
 * `1.5`, not `"1.5"`, and a field sent three times is an array of three. Comparing the raw form
 * strings with the typed record reads every non-string field as dropped.
 */
function coerceFormValue(values: string[], schema: Record<string, unknown> | undefined): unknown {
	const types = [schema?.type].flat()
	const scalar = (value: string, of: Record<string, unknown> | undefined): unknown => {
		const kinds = [of?.type].flat()
		if (kinds.includes("integer") || kinds.includes("number")) {
			const number = Number(value)
			return value.trim() !== "" && Number.isFinite(number) ? number : value
		}
		if (kinds.includes("boolean") && (value === "true" || value === "false")) return value === "true"
		return value
	}
	if (types.includes("array")) {
		const items = schema?.items as Record<string, unknown> | undefined
		return values.map((value) => scalar(value, items))
	}
	return scalar(values.at(-1) ?? "", schema)
}

function submittedFields(body: unknown): Record_ {
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const out: Record_ = {}
		for (const [name, value] of body.entries()) {
			if (typeof value === "string") out[name] = value
		}
		return out
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return Object.fromEntries(body.entries())
	}
	if (
		body !== null &&
		typeof body === "object" &&
		!Array.isArray(body) &&
		Array.isArray((body as { parts?: unknown }).parts)
	) {
		const out: Record_ = {}
		for (const part of (body as { parts: Array<Record<string, unknown>> }).parts) {
			if (typeof part.field === "string" && typeof part.value === "string") out[part.field] = part.value
		}
		return out
	}
	if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record_
	return {}
}

/** Document first, then the live `Content-Type`. Media type is the stream tag — not `x-async`. */
function isEventStream(exchange: Exchange, op?: OperationModel): boolean {
	if (op?.eventStream === true) return true
	const type = exchange.responseHeaders["content-type"] ?? ""
	return type.includes("text/event-stream")
}

/**
 * JSON request body declared on the operation, filled from known flow values.
 *
 * Path-only accept/revoke (`POST /invites/{token}` with no body) stay path-only.
 */
function documentedJsonBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, string>,
): Record<string, unknown> | undefined {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	if (picked === null || !picked.mediaType.includes("json")) return undefined
	const properties = picked.schema.properties
	if (properties !== null && typeof properties === "object") {
		const names = Object.keys(properties as object)
		if (names.length > 0) {
			const body: Record<string, unknown> = {}
			for (const name of names) {
				if (fields[name] !== undefined) body[name] = fields[name]
			}
			return body
		}
	}
	if (fields.token !== undefined) return { token: fields.token }
	if (fields.grant_id !== undefined) return { grant_id: fields.grant_id }
	return { ...fields }
}

interface ConstrainedField {
	name: string
	schema: Record<string, unknown>
}

function findConstrained(
	schema: Record<string, unknown>,
	predicate: (s: Record<string, unknown>) => boolean,
): ConstrainedField | null {
	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	for (const [name, raw] of Object.entries(props as Record<string, Record<string, unknown>>)) {
		if (raw === null || typeof raw !== "object") continue
		if (raw.readOnly === true) continue
		if (predicate(raw)) return { name, schema: raw }
		const union = raw.oneOf ?? raw.anyOf
		if (Array.isArray(union)) {
			const branch = union.find(
				(candidate) =>
					candidate !== null && typeof candidate === "object" && predicate(candidate as Record<string, unknown>),
			)
			if (branch !== undefined) return { name, schema: branch as Record<string, unknown> }
		}
	}
	return null
}

/**
 * Order matters. Cascade suppression consults findings already reported for this entity, so a
 * check must run after everything it depends on — primitives first, then the properties built
 * on top of them. Otherwise a broken primitive is reported once as itself and again as every
 * downstream consequence.
 */
/**
 * An operation declaring `x-effects` must produce the stated change.
 *
 * `count` is an exact cardinality delta (default 1). `min` is at-least. After a `create` on A,
 * later items in the same array fill a child list under A with the new id — from the write
 * response (`table_id` or the entity identity) or from A's list delta.
 *
 * `x-invalidate` says a read route changes; `x-effects` says *how*. That difference is what
 * separates "something differed" — which is satisfied by a stray timestamp and missed by a
 * cache-stale read — from an assertion on cardinality and membership.
 */
/**
 * A numeric field must compare numerically, not lexically.
 *
 * Query values arrive from a URL as text, and a backend that forgets to coerce them compares
 * "10" < "9" — so `amount.gt.9` silently omits 10, 20 and 100. The result is a plausible-looking
 * subset rather than an error, which is why it survives in production.
 */
const numericComparisonIsNumeric: Check<{
	field: string
	threshold: number
	expected: string[]
	gtTerm: Record<string, string>
}> = {
	plan: (ctx) => {
		const field = filterable(ctx) && ctx.records.length > 2 ? numericFilterField(ctx) : null
		if (field === null) return cannot()
		const values = ctx.records.map((r) => r[field]).filter((v): v is number => typeof v === "number")
		if (values.length < 3) return cannot(`three cohort records with a number in "${field}"`)
		/* A threshold that partitions the cohort, chosen so the lexical and numeric answers
		 * differ — comparing as text has to produce a visibly wrong set for this to prove
		 * anything. */
		const sorted = [...new Set(values)].sort((a, b) => a - b)
		const threshold = sorted[Math.floor(sorted.length / 2)]
		if (threshold === undefined) return cannot()
		const expected = ctx.records
			.filter((r) => typeof r[field] === "number" && (r[field] as number) > threshold)
			.map((r) => String(r[ctx.identity]))
			.sort()
		if (expected.length === 0) return cannot(`a cohort value of "${field}" above the median`)
		const gtTerm = filterTerm(conv(ctx), field, "gt", threshold)
		if (gtTerm === null) return cannot("a filter grammar with a gt operator")
		return ready({ expected, field, gtTerm, threshold })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"pagination.page-walk-covers-set",
		"list.read-after-write",
		"filter.unknown-field-rejected",
	],
	id: "filter.numeric-comparison-is-numeric",
	needs: "a `filter` parameter and a numeric field",
	subjects: subjectsOf.list,
	async run(ctx, { expected, field, gtTerm, threshold }): Promise<Outcome> {
		/* The whole filtered set: a record above the threshold on the second page is not missing. */
		const read = await readSet(ctx, gtTerm)
		if (read.status !== "ok") {
			return ctx.findings.unresolved(this.id, ctx.entityName, read.reason ?? "the comparison was rejected")
		}
		if (!read.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered set is larger than a read covers")
		}
		const result = read.last
		const got = ids(read.items, ctx.identity)
		const gotKnown = [...knownHits(read.items, ctx)].sort()
		if (gotKnown.join(",") === expected.join(",")) return ASSERTED

		const missing = expected.filter((id) => !gotKnown.includes(id))
		const extra = gotKnown.filter((id) => !expected.includes(id))
		const lexical = expected.filter((id) => {
			const record = ctx.records.find((r) => String(r[ctx.identity]) === id)
			return record !== undefined && String(record[field]) < String(threshold)
		})
		const comparedAsText = missing.length > 0 && missing.every((id) => lexical.includes(id))

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			comparedAsText
				? `"${field}" is compared as text rather than as a number`
				: `"${field}" comparison does not agree with numeric ordering`,
			`filter=${field}.gt.${threshold} returned ${got.length} record(s); ${expected.length} known ` +
				`records hold a greater numeric value. Missing: ${missing.slice(0, 4).join(", ") || "none"}. ` +
				`Unexpected: ${extra.slice(0, 4).join(", ") || "none"}. ` +
				(comparedAsText
					? "Every missing record is one whose value sorts below the threshold as a string, " +
						"so the comparison is lexical: the query value was never coerced from text."
					: "The comparison does not agree with numeric ordering."),
			[result.exchange],
		)
	},
}

function numericFilterField(ctx: CheckContext): string | null {
	return cohortFact(ctx, "numeric-filter", () => computeNumericFilterField(ctx))
}

function computeNumericFilterField(ctx: CheckContext): string | null {
	for (const field of ctx.query?.filterable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => r[field])
		const numbers = values.filter((v) => typeof v === "number")
		if (numbers.length < 3) continue
		/* Only useful when text and numeric ordering actually disagree across the cohort. */
		const asNumbers = [...new Set(numbers as number[])].sort((a, b) => a - b)
		const asText = [...new Set(numbers as number[])].sort((a, b) => String(a).localeCompare(String(b)))
		if (asNumbers.join(",") !== asText.join(",")) return field
	}
	return null
}

/**
 * Concurrent writes to different fields must both survive.
 *
 * A handler that reads the row, then writes every column back — the `save(entity)` pattern —
 * reinstates whatever it read, so the later write silently reverts the earlier one. No error is
 * returned to either caller, which is what makes it so hard to notice from the outside.
 */
const noLostUpdate: Check<{ updateOp: OperationModel; readOp: OperationModel }> = {
	plan: (ctx) => {
		const { readOp, updateOp } = ctx
		if (updateOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		/* Two concurrent PUTs each replace the whole record, so one losing the other's field is
		 * what PUT means. Only partial writes can be lost. */
		if (updateOp.method.toUpperCase() !== "PATCH") return cannot("an update by PATCH, whose writes are partial")
		return ready({ readOp, updateOp })
	},
	dependsOn: [
		"list.read-after-write",
		"patch.minimality",
		/* If writes do not persist at all, "the write was lost" describes a consequence rather
		 * than a concurrency defect. */
		"create.persists-submitted-fields",
	],
	id: "concurrency.no-lost-update",
	needs: "a create, a PATCH update and two writable string fields",
	mutates: true,
	subjects: subjectsOf.update,
	async run(ctx, { readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const id = made.scratch.id
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const before = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		if (before.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back returned ${before.status}, so there was no baseline to race ` + "against",
			)
		}
		const original = (before.responseBody ?? {}) as Record_

		/* Two distinct writable string fields, so the writes cannot legitimately clobber each
		 * other — last-write-wins on the *same* field would be a defensible policy. */
		const fields = writableStringFields(ctx, original).slice(0, 2)
		const [first, second] = fields
		if (first === undefined || second === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`only ${fields.length} writable string field(s) are present on the record; two are ` +
					"needed so the concurrent writes cannot legitimately clobber each other",
			)
		}

		const path = fillPath(updateOp.path, params)
		const [firstWrite, secondWrite] = await Promise.all([
			ctx.client.request("PATCH", path, {
				body: { [first]: "oat-concurrent-a" },
				headers: ctx.auth(),
			}),
			ctx.client.request("PATCH", path, {
				body: { [second]: "oat-concurrent-b" },
				headers: ctx.auth(),
			}),
		])
		if (standDownForFeatureGate(ctx, updateOp, firstWrite, this.id))
			return standDown("a documented feature gate refused the request")
		if (standDownForFeatureGate(ctx, updateOp, secondWrite, this.id))
			return standDown("a documented feature gate refused the request")
		if (standDownForRateLimit(ctx, firstWrite, this.id)) return standDown("the request was rate limited")
		if (standDownForRateLimit(ctx, secondWrite, this.id)) return standDown("the request was rate limited")
		if (firstWrite.status >= 300 || secondWrite.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a concurrent PATCH was rejected (${firstWrite.status}, ${secondWrite.status}), so no ` +
					"race actually took place",
			)
		}

		const after = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		if (after.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back after the race returned ${after.status}`,
			)
		}
		const current = (after.responseBody ?? {}) as Record_

		const lost: string[] = []
		if (current[first] !== "oat-concurrent-a") lost.push(first)
		if (current[second] !== "oat-concurrent-b") lost.push(second)
		if (lost.length === 0) {
			return ASSERTED
		}

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a concurrent write to a different field was silently lost",
			`two simultaneous patches set "${first}" and "${second}" — different fields, so neither ` +
				`conflicts with the other — and both returned success, but ${lost.join(" and ")} ` +
				`read back as ${lost.map((f) => JSON.stringify(current[f])).join(", ")} afterwards. ` +
				"The update path reads the record and writes every column back, so whichever request " +
				"commits second reinstates the values it read before the first had committed. Callers " +
				"are told the write succeeded.",
			[firstWrite, secondWrite, after],
		)
	},
}

/**
 * Fields a probe may write an arbitrary string into without the backend having grounds to refuse.
 *
 * "Writable" is not enough: an enum, a pattern or a length cap makes an arbitrary value invalid,
 * and a backend that rejects or normalises it is behaving correctly. Reading that back as a lost
 * write turns sound validation into a fabricated concurrency bug — which is exactly what happened
 * when a probe value was written into a `status` enum.
 */
function writableStringFields(ctx: CheckContext, record: Record_): string[] {
	const immutable = new Set([...(ctx.updateOp?.immutable ?? []), ...(ctx.updateOp?.generated ?? [])])
	const schema = ctx.updateOp === undefined ? null : requestSchemaOf(ctx, ctx.updateOp)
	const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>

	/* Where the update body enumerates its properties, that list *is* the set of writable fields —
	 * a field the request schema does not mention is one the caller was never invited to send, and
	 * a backend is right to ignore it. Reading the record instead of the schema is what let a probe
	 * target `status` on an operation that only accepts `name`. */
	const enumerated = Object.keys(properties).length > 0

	const out: string[] = []
	for (const [key, value] of Object.entries(record)) {
		if (immutable.has(key) || key === ctx.identity) continue
		if (/_at$|_id$/.test(key)) continue
		if (typeof value !== "string") continue

		const declared = properties[key]
		if (enumerated && declared === undefined) continue
		if (declared !== undefined) {
			if (Array.isArray(declared.enum)) continue
			if (typeof declared.pattern === "string") continue
			if (typeof declared.format === "string") continue
			/* The probe values are short, but a cap tight enough to reject them would make the
			 * write fail for a reason that has nothing to do with concurrency. */
			if (typeof declared.maxLength === "number" && declared.maxLength < 32) continue
		}
		out.push(key)
	}
	return out
}

const declaredEffectsOccur: Check = {
	plan: (ctx) => when(ctx.effectOps.length > 0),
	/* An effect is counted by reading whole sets before and after, across pages. */
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	mutates: true,
	id: "effects.declared-effect-occurs",
	needs: "an operation declaring x-effects",
	subjects: subjectsOf.effects,
	async run(all): Promise<Outcome> {
		for (const op of all.effectOps) {
			const ctx = forOperation(all, op)
			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const effects = op.effects
				if (effects.length === 0) return

				let scope = bindInstanceScope(ctx.model, ctx.entityName, ctx.identity, ctx.records, ctx.scope)
				const raw = ctx.model.rawOperations.get(op.operationId) as
					| { "x-bind"?: unknown; "x-before"?: unknown }
					| undefined
				const actionBind = readActionBind(raw?.["x-bind"])
				const beforeId = readBefore(raw?.["x-before"])
				let beforeBody: unknown
				if (beforeId !== undefined) {
					const beforeOp = ctx.model.byOperationId.get(beforeId)
					if (beforeOp === undefined) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} names x-before "${beforeId}", which is not an operation`,
							"the action was not invoked",
							fixture,
						)
						return
					}
					const beforeScope = bindActionScope(beforeOp.pathParams, ctx.records, scope, null, undefined)
					if (!canFillPath(beforeOp.path, beforeScope)) {
						const missing = beforeOp.pathParams.filter((name) => beforeScope[name] === undefined)
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} could not run x-before "${beforeId}"`,
							`missing ${missing.map((name) => `{${name}}`).join(", ")}`,
							fixture,
						)
						return
					}
					const beforeFields = beforeOp.hasRequestBody ? bodyForOp(ctx, beforeOp) : undefined
					const beforeInvoked = await ctx.client.request(beforeOp.method, fillPath(beforeOp.path, beforeScope), {
						headers: ctx.auth(),
						operationId: beforeOp.operationId,
						...(beforeFields === undefined
							? {}
							: await encodeOpBody(ctx, beforeOp, beforeFields, "baseline", 0, uploads)),
					})
					if (beforeInvoked.status >= 400) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${beforeId} (x-before) returned ${beforeInvoked.status}`,
							`${op.operationId} was not invoked`,
							fixture,
						)
						return
					}
					beforeBody = beforeInvoked.responseBody
				}
				scope = bindActionScope(op.pathParams, ctx.records, scope, actionBind, beforeBody)
				if (!canFillPath(op.path, scope)) {
					const missing = op.pathParams.filter((name) => scope[name] === undefined)
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be invoked`,
						`missing ${missing.map((name) => `{${name}}`).join(", ")}`,
						fixture,
					)
					return
				}
				const befores = new Map<string, Observation>()

				for (const effect of effects) {
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) continue
					if (befores.has(effect.entity)) continue
					befores.set(effect.entity, await observe(ctx, listOp, scope))
				}

				const prepared = applyActionBind(
					actionBind,
					ctx.records,
					beforeBody,
					op.hasRequestBody ? bodyForOp(ctx, op) : undefined,
				)
				const body = prepared.body
				const invoked = await ctx.client.request(op.method, fillPath(op.path, scope), {
					headers: ctx.auth(),
					operationId: op.operationId,
					...(fixture === undefined ? {} : { fixture }),
					...(Object.keys(prepared.query).length === 0 ? {} : { query: prepared.query }),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, invoked, this.id)) return
				if (standDownForRateLimit(ctx, invoked, this.id)) return
				if (invoked.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be invoked`,
						`returned ${invoked.status}; its declared effects are unverified`,
						fixture,
					)
					return
				}

				const deltas = new Map<string, string[]>()
				Object.assign(scope, bindAfterCreateEffects(ctx.model, effects, invoked.responseBody, deltas))

				for (const effect of effects) {
					if (effect.op !== "create") continue
					const param = identityPathParam(ctx.model, effect.entity)
					if (scope[param] !== undefined) continue
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) continue
					const afterParent = await observe(ctx, listOp, scope)
					if (afterParent.status !== "ok") continue
					const before = befores.get(effect.entity)
					const prior = before?.status === "ok" ? before.ids : []
					const added = afterParent.ids.filter((id) => !prior.includes(id))
					deltas.set(effect.entity, added)
					Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, invoked.responseBody, added))
				}

				for (const effect of effects) {
					const listOp = listOpFor(ctx, effect.entity)
					if (listOp === undefined) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", which has no list route`,
							"the effect cannot be observed, so it is not verified",
							fixture,
						)
						continue
					}

					if (!canFillPath(listOp.path, scope)) {
						const missing = listOp.pathParams.filter((name) => scope[name] === undefined)
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", but the list path cannot be filled`,
							`missing ${missing.map((name) => `{${name}}`).join(", ")} after the write; the effect is unverified`,
							fixture,
						)
						continue
					}

					const after = await observe(ctx, listOp, scope)
					if (after.status === "error") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} could not observe "${effect.entity}" after the write`,
							`${after.reason ?? `list returned ${after.exchange.status}`}; the declared effect is unverified`,
							fixture,
						)
						continue
					}
					if (after.status === "unfillable") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} declares an effect on "${effect.entity}", but the list path cannot be filled`,
							"the child list still lacks a parent id after the write; the effect is unverified",
							fixture,
						)
						continue
					}

					const before = befores.get(effect.entity)
					if (before?.status === "error") {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} could not observe "${effect.entity}" before the write`,
							`${before.reason ?? `list returned ${before.exchange.status}`}; no baseline, so the effect is unverified`,
							fixture,
						)
						continue
					}
					const prior = before?.status === "ok" ? before.ids : []
					const delta = after.ids.length - prior.length
					const added = after.ids.filter((id) => !prior.includes(id))
					const removed = prior.filter((id) => !after.ids.includes(id))
					/* Records the operation made on oat's behalf are oat's to remove. */
					if (effect.op === "create" || effect.op === "append") {
						for (const id of added) ctx.recordCreated?.(effect.entity, id, { ...scope })
					}

					if (effectHolds(effect, delta, added.length, removed.length)) {
						if (effect.op === "create") {
							Object.assign(scope, bindCreatedScope(ctx.model, effect.entity, invoked.responseBody, added))
						}
						continue
					}

					const hold = describeEffectHold(effect)
					if (effect.op === "create" || effect.op === "append") {
						ctx.findings.backend(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} did not produce the "${effect.entity}" records it declares`,
							`x-effects declares ${hold} on "${effect.entity}", but the ` +
								`collection went from ${prior.length} to ${after.ids.length} ` +
								`(${added.length} added, ${removed.length} removed). A declared effect that does ` +
								"not occur means callers cannot rely on the operation having done anything.",
							[invoked, after.exchange],
							fixture,
						)
						continue
					}

					if (effect.op === "delete") {
						ctx.findings.backend(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} did not remove the "${effect.entity}" records it declares`,
							`x-effects declares ${hold} on "${effect.entity}", but the collection ` +
								`went from ${prior.length} to ${after.ids.length}`,
							[invoked, after.exchange],
							fixture,
						)
						continue
					}

					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} changed the size of "${effect.entity}" while declaring ${effect.op}`,
						`x-effects declares ${effect.op}, which must not add or remove records, but the ` +
							`collection went from ${prior.length} to ${after.ids.length}`,
						[invoked, after.exchange],
						fixture,
					)
				}
			})
		}
		return ASSERTED
	},
}

/**
 * After a write that declares `x-wait`, poll the named GET until a JSON path is occupied
 * (or `awaitSideEffect` returns true). Timeout is a backend finding, not a coverage gap.
 */
const sideEffectArrives: Check = {
	plan: (ctx) => when(ctx.waitOps.length > 0),
	dependsOn: ["list.read-after-write"],
	mutates: true,
	id: "effects.side-effect-arrives",
	needs: "an operation declaring x-wait",
	subjects: subjectsOf.waits,
	async run(all): Promise<Outcome> {
		for (const op of all.waitOps) {
			const ctx = forOperation(all, op)
			const spec = op.wait
			if (spec === null) continue
			const pollOp = ctx.model.byOperationId.get(spec.operationId)
			if (pollOp === undefined) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${op.operationId} x-wait names "${spec.operationId}", which is not in the document`,
					"the side effect cannot be observed, so it is not verified",
				)
				continue
			}

			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
				const invoked = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					operationId: op.operationId,
					...(fixture === undefined ? {} : { fixture }),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, invoked, this.id)) return
				if (standDownForRateLimit(ctx, invoked, this.id)) return
				if (invoked.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be invoked`,
						`returned ${invoked.status}; its declared x-wait is unverified`,
						fixture,
					)
					return
				}

				const scope = bindWaitScope(ctx, op, pollOp, invoked.responseBody)
				const outcome = await driveWait({
					awaitSideEffect: ctx.hooks.awaitSideEffect,
					client: ctx.client,
					headers: ctx.auth,
					pollOp,
					record: invoked.responseBody,
					scope,
					spec,
					writeOpId: op.operationId,
					...(ctx.refreshIfStale === undefined ? {} : { refreshIfStale: ctx.refreshIfStale }),
				})
				if (!outcome.timedOut) return
				ctx.findings.backend(
					this.id,
					subject(ctx.entityName, op.operationId, fixture),
					`${op.operationId} side effect did not appear within ${spec.timeoutMs}ms`,
					`x-wait polls ${spec.operationId}` +
						(spec.until === undefined ? "" : ` until ${spec.until} is non-empty`) +
						` and the path was still empty after ${outcome.polls} poll(s) / ${Math.round(outcome.elapsedMs)}ms. ` +
						"Queue consumers and webhook inboxes are not the same request; a timeout here is a " +
						"missed delivery, not a coverage gap.",
					[invoked, ...outcome.exchanges.slice(-2)],
					fixture,
				)
			})
		}
		return ASSERTED
	},
}

type Observation =
	| { status: "unfillable" }
	| { status: "error"; exchange: Exchange; reason?: string }
	| { status: "ok"; ids: string[]; exchange: Exchange }

function listOpFor(ctx: CheckContext, entityName: string): OperationModel | undefined {
	const listId = ctx.model.entities.get(entityName)?.list
	return listId === undefined ? undefined : ctx.model.byOperationId.get(listId)
}

function bindWaitScope(
	ctx: CheckContext,
	writeOp: OperationModel,
	pollOp: OperationModel,
	writeBody: unknown,
): Record<string, string> {
	const scope = { ...ctx.scope }
	Object.assign(scope, bindAfterCreateEffects(ctx.model, writeOp.effects, writeBody))
	Object.assign(scope, bindMissingPathParams(pollOp.pathParams, scope, writeBody))
	return scope
}

async function observe(
	ctx: CheckContext,
	listOp: OperationModel,
	scope: Record<string, string> = ctx.scope,
): Promise<Observation> {
	let path: string
	try {
		path = fillPath(listOp.path, scope)
	} catch {
		return { status: "unfillable" }
	}
	void path
	/* The whole collection: an effect that adds one record to a collection larger than a page
	 * is invisible on the first page, and reads as an effect that never happened. */
	const view = forList(ctx, listOp)
	const read = await readSet(view, {}, { fresh: true, scope })
	if (read.status !== "ok") return { exchange: read.last.exchange, status: "error" }
	if (!read.complete) {
		return {
			exchange: read.last.exchange,
			reason: read.reason ?? "the collection is larger than a read covers",
			status: "error",
		}
	}
	return { exchange: read.last.exchange, ids: ids(read.items, view.identity), status: "ok" }
}

const asyncReachesTerminalState: Check = {
	plan: (ctx) => when(ctx.asyncOps.length > 0),
	mutates: true,
	id: "async.reaches-terminal-state",
	needs: "an operation declaring x-async",
	subjects: subjectsOf.async,
	async run(all): Promise<Outcome> {
		for (const op of all.asyncOps) {
			const ctx = forOperation(all, op)
			const spec = op.async
			if (spec === null) continue

			await forEachInvocation(op.operationId, ctx.uploads, async (uploads, slot) => {
				const fixture = slot?.filename
				const body = op.hasRequestBody ? bodyForOp(ctx, op) : undefined
				const start = await ctx.client.request(op.method, fillPath(op.path, ctx.scope), {
					headers: ctx.auth(),
					...(body === undefined ? {} : await encodeOpBody(ctx, op, body, "baseline", 0, uploads)),
				})
				if (standDownForFeatureGate(ctx, op, start, this.id)) return
				if (start.status >= 400) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} could not be started`,
						`returned ${start.status}; the async lifecycle after it is untested`,
						fixture,
					)
					return
				}

				const streamed = isEventStream(start, op)
				const fromStream = streamed ? inspectStreamAsync(start.responseBody, spec) : null
				if (fromStream?.terminal !== null && fromStream?.terminal !== undefined) {
					if (spec.successWhen !== undefined && !matchesPredicate(fromStream.terminal, spec.successWhen)) {
						ctx.findings.gap(
							this.id,
							subject(ctx.entityName, op.operationId, fixture),
							`${op.operationId} reached a non-success terminal state`,
							`terminal state did not satisfy "${spec.successWhen}"; downstream effects of ` +
								"this operation are untested",
							fixture,
						)
					}
					return
				}

				const receipt =
					fromStream?.idRecord !== null && fromStream?.idRecord !== undefined ? fromStream.idRecord : start.responseBody
				if (streamed && fromStream !== null && (fromStream.id === undefined || fromStream.id === null)) {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} job disappeared before completing`,
						"the stream ended without a terminal frame and without a job id, so the poll route cannot be named.",
						[start],
						fixture,
					)
					return
				}

				const outcome = await driveAsync(
					ctx.client,
					spec,
					receipt,
					ctx.scope,
					ctx.auth,
					ctx.refreshIfStale,
					(operationId) => ctx.model.byOperationId.get(operationId),
				)
				/* The job this start created is a record like any other, and oat's to remove. */
				const jobId = spec.idFrom === undefined ? undefined : resolveAsyncId(receipt, spec.idFrom)
				const polled = (ctx.model.byRoute.get(spec.poll) ?? ctx.model.byOperationId.get(spec.poll))?.entity
				if ((typeof jobId === "string" || typeof jobId === "number") && polled !== null && polled !== undefined) {
					ctx.recordCreated?.(polled, String(jobId), { ...ctx.scope })
				}

				if (outcome.timedOut) {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} never reached a terminal state`,
						`polled ${spec.poll} ${outcome.polls} time(s) over ${Math.round(outcome.elapsedMs)}ms ` +
							`without satisfying "${spec.until ?? "any terminal state"}". A job that neither ` +
							"completes nor fails leaves callers polling forever.",
						[start, ...outcome.exchanges.slice(-2)],
						fixture,
					)
					return
				}

				if (outcome.state === "unfillable") {
					/* oat could not name the job to ask about it: nothing the backend did. */
					ctx.findings.unresolved(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`the poll route ${spec.poll} could not be filled from the receipt: ${outcome.unfillable ?? "a parameter is missing"}`,
					)
					return
				}

				if (outcome.state === "vanished") {
					ctx.findings.backend(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} job disappeared before completing`,
						`the poll route stopped serving the job after ${outcome.polls} poll(s). A job that ` +
							"vanishes is indistinguishable from one that never existed.",
						[start, ...outcome.exchanges.slice(-2)],
						fixture,
					)
					return
				}

				if (!outcome.succeeded) {
					ctx.findings.gap(
						this.id,
						subject(ctx.entityName, op.operationId, fixture),
						`${op.operationId} reached a non-success terminal state`,
						`terminal state did not satisfy "${spec.successWhen ?? ""}"; downstream effects of ` +
							"this operation are untested",
						fixture,
					)
				}
			})
		}
		return ASSERTED
	},
}

const asyncReceiptIsResolvable: Check = {
	plan: (ctx) => when(ctx.asyncOps.some((op) => op.async?.idFrom !== undefined)),
	id: "async.receipt-identifies-the-job",
	judgesTranscript: true,
	needs: "x-async with an idFrom pointer",
	subjects: subjectsOf.asyncReceipt,
	async run(all): Promise<Outcome> {
		for (const op of all.asyncOps) {
			const ctx = forOperation(all, op)
			const spec = op.async
			if (spec?.idFrom === undefined) continue

			/* Match the async operation's own exchange by resolved path — any POST would do here
			 * otherwise, and a sibling create's response would be inspected instead. */
			let resolved: string
			try {
				resolved = fillPath(op.path, ctx.scope)
			} catch {
				continue
			}
			const started = ctx.client
				.exchangesFor(op.operationId)
				.find((e) => e.status < 300 && ctx.client.relativePath(e.url) === resolved)
			if (started === undefined) continue

			const node = resolveAsyncId((await ctx.client.hydrate(started)).responseBody, spec.idFrom)
			if (node !== undefined && node !== null) continue

			ctx.findings.spec(
				this.id,
				ctx.entityName,
				`${op.operationId} response does not carry the job identifier it declares`,
				`x-async names "${spec.idFrom}" as the job id, but the response has no such value. ` +
					"Callers cannot poll for a job they cannot name.",
				[started],
			)
		}
		return ASSERTED
	},
}

const ASCII_PAYLOAD_PROBE = "oat-payload-probe"

interface PayloadField {
	name: string
	maxLength: number | undefined
	minLength: number | undefined
}

function pickPayloadField(ctx: CheckContext, op: OperationModel): PayloadField | null {
	const schema = requestSchemaOf(ctx, op)
	const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
	const immutable = new Set([
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...(ctx.createOp?.generated ?? []),
		ctx.identity,
	])
	let best: (PayloadField & { score: number }) | null = null
	for (const [name, declared] of Object.entries(properties)) {
		if (immutable.has(name) || /_at$|_id$/.test(name)) continue
		if (declared === null || typeof declared !== "object") continue
		if (declared.readOnly === true) continue
		const union = declared.oneOf ?? declared.anyOf
		const branch = Array.isArray(union)
			? (union.find(
					(candidate) =>
						candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === "string",
				) as Record<string, unknown> | undefined)
			: undefined
		const stringSchema = branch ?? declared
		const type = stringSchema.type
		const isString = type === "string" || (Array.isArray(type) && type.includes("string"))
		if (!isString && type !== undefined) continue
		if (Array.isArray(stringSchema.enum)) continue
		if (typeof stringSchema.pattern === "string") continue
		if (typeof stringSchema.format === "string") continue
		const maxLength = typeof stringSchema.maxLength === "number" ? stringSchema.maxLength : undefined
		const minLength = typeof stringSchema.minLength === "number" ? stringSchema.minLength : undefined
		if (maxLength !== undefined && maxLength < 8) continue
		const nullable =
			declared.nullable === true ||
			(Array.isArray(declared.type) && declared.type.includes("null")) ||
			(Array.isArray(union) &&
				union.some(
					(candidate) =>
						candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === "null",
				))
		const score = (nullable ? 1000 : 0) + (maxLength ?? 1024)
		if (best === null || score > best.score) best = { maxLength, minLength, name, score }
	}
	return best
}

const stringPayloadSurvives: Check<{
	writeOp: OperationModel
	readOp: OperationModel
	field: PayloadField
}> = {
	plan: (ctx) => {
		const writeOp = ctx.updateOp ?? ctx.createOp
		const readOp = ctx.readOp
		if (writeOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		if (ctx.updateOp === undefined && ctx.deleteOp === undefined) return cannot()
		const field = pickPayloadField(ctx, writeOp)
		if (field === null) return cannot("a writable string field without a format or pattern to probe payloads against")
		return ready({ field, readOp, writeOp })
	},
	dependsOn: ["list.read-after-write"],
	id: "payload.string-survives",
	mutates: true,
	needs: "an update or create+delete, an item route, and a writable unconstrained string",
	subjects: subjectsOf.writeAndRead,
	async run(ctx, { field, readOp, writeOp }): Promise<Outcome> {
		const updateOp = ctx.updateOp
		const viaPatch = updateOp !== undefined
		/* Writes go to a record made for this check; with no update, each write is a create of its
		 * own and is removed once read back. */
		let id = ""
		let current: Record_ = {}
		if (viaPatch) {
			const made = await scratchRecord(ctx, this.id)
			if ("outcome" in made) return made.outcome
			id = made.scratch.id
			current = made.scratch.record
		}

		const writeField = async (value: unknown, recordId: string): Promise<Exchange> => {
			if (updateOp !== undefined) {
				const update = await updateRequest(ctx, updateOp, current, { [field.name]: value })
				return ctx.client.request(
					update.method,
					fillPath(updateOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }),
					{ ...update.options, headers: ctx.auth(), operationId: updateOp.operationId },
				)
			}
			const createOp = ctx.createOp
			if (createOp === undefined) throw new Error("payload probe has no write operation")
			const body = { ...validBody(ctx, requestSchemaOf(ctx, createOp) ?? {}), [field.name]: value }
			return ctx.client.request("POST", fillPath(createOp.path, ctx.scope), { body, headers: ctx.auth() })
		}

		const readField = async (recordId: string): Promise<{ exchange: Exchange; value: unknown }> => {
			const exchange = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }), {
				headers: ctx.auth(),
			})
			const body = (exchange.responseBody ?? {}) as Record_
			return { exchange, value: body[field.name] }
		}

		const remove = async (recordId: string): Promise<void> => {
			if (viaPatch || ctx.deleteOp === undefined) return
			await ctx.client.request(
				"DELETE",
				fillPath(ctx.deleteOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }),
				{
					headers: ctx.auth(),
				},
			)
		}

		const identityOf = (exchange: Exchange): string | undefined => {
			const body = exchange.responseBody
			if (body === null || typeof body !== "object") return undefined
			const value = (body as Record_)[ctx.identity]
			return value === undefined || value === null ? undefined : String(value)
		}

		const control = await writeField(ASCII_PAYLOAD_PROBE, id)
		if (standDownForFeatureGate(ctx, writeOp, control, this.id))
			return standDown("a documented feature gate refused the request")
		if (standDownForRateLimit(ctx, control, this.id)) return standDown("the request was rate limited")
		if (control.status === 401 || control.status === 403) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the ASCII control write returned ${control.status}, so later refusals cannot be attributed to the payload`,
			)
		}
		if (control.status >= 400 && control.status < 500) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the ASCII control write was rejected with ${control.status}, so the field refuses ordinary strings`,
			)
		}
		if (control.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an ordinary ASCII write returned 5xx",
				`PATCH/POST of "${ASCII_PAYLOAD_PROBE}" on "${field.name}" returned ${control.status}.`,
				[control],
			)
		}
		const controlId = viaPatch ? id : identityOf(control)
		if (controlId === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the ASCII control write did not return an identity, so the value could not be read back",
			)
		}
		const controlRead = await readField(controlId)
		if (!viaPatch) await remove(controlId)
		if (controlRead.value !== ASCII_PAYLOAD_PROBE) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an ordinary ASCII write did not persist exactly",
				`"${field.name}" was sent ${JSON.stringify(ASCII_PAYLOAD_PROBE)} and read back ` +
					`${JSON.stringify(controlRead.value)}.`,
				[control, controlRead.exchange],
			)
		}

		const { cases, narrowed } = payloadCases(ctx, writeOp, field)

		/* Every case on its own: what happened to the value, or why the run must stop. */
		type CaseResult =
			| { kind: "kept" }
			| { kind: "failed"; line: string; evidence: Exchange[] }
			| { kind: "stop"; outcome: Outcome }
			| { kind: "lost-auth" }
		const runCase = async (payload: StringPayload, recordId: string): Promise<CaseResult> => {
			const written = await writeField(payload.value, recordId)
			if (standDownForFeatureGate(ctx, writeOp, written, this.id)) {
				return { kind: "stop", outcome: standDown("a documented feature gate refused the request") }
			}
			if (written.status === 401) {
				const retry = await writeField(ASCII_PAYLOAD_PROBE, recordId)
				if (retry.status >= 400) return { kind: "lost-auth" }
				return {
					evidence: [written],
					kind: "failed",
					line: `${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got HTTP 401`,
				}
			}
			if (standDownForRateLimit(ctx, written, this.id)) {
				return { kind: "stop", outcome: standDown("the request was rate limited") }
			}
			if (written.status === 404 || written.status === 409 || written.status === 415) return { kind: "kept" }
			if (written.status >= 400) {
				if (!viaPatch && written.status < 500) {
					const extra = identityOf(written)
					if (extra !== undefined) await remove(extra)
				}
				return {
					evidence: [written],
					kind: "failed",
					line: `${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got HTTP ${written.status}`,
				}
			}
			const writtenId = viaPatch ? recordId : identityOf(written)
			if (writtenId === undefined) {
				return {
					evidence: [written],
					kind: "failed",
					line: `${payload.id} (${payload.why}): write succeeded but returned no identity`,
				}
			}
			const got = await readField(writtenId)
			if (!viaPatch) await remove(writtenId)
			if (got.value === payload.value) return { kind: "kept" }
			return {
				evidence: [written, got.exchange],
				kind: "failed",
				line: `${payload.id} (${payload.why}): sent ${JSON.stringify(payload.value)}, got ${JSON.stringify(got.value)}`,
			}
		}

		/*
		 * Fanned across records: each lane takes every n-th case on a record of its own, and the
		 * lanes run together. Through an update the lanes need records of their own — one write
		 * must never be read back as another's — so the extra ones are made here; through create,
		 * every case is a record of its own already.
		 */
		const laneRecords = [id]
		if (viaPatch) {
			while (laneRecords.length < Math.min(PAYLOAD_LANES, cases.length)) {
				const made = await scratchRecord(ctx, this.id)
				if ("outcome" in made) break
				laneRecords.push(made.scratch.id)
			}
		}
		const lanes = Math.max(1, Math.min(PAYLOAD_LANES, cases.length))
		const results = Array.from<CaseResult | undefined>({ length: cases.length })
		let stopped = false
		await Promise.all(
			Array.from({ length: lanes }, async (_, lane) => {
				const recordId = laneRecords[lane % laneRecords.length] ?? id
				for (let index = lane; index < cases.length; index += lanes) {
					if (stopped) return
					const payload = cases[index]
					if (payload === undefined) continue
					const result = await runCase(payload, recordId)
					results[index] = result
					if (result.kind === "stop" || result.kind === "lost-auth") stopped = true
				}
			}),
		)

		const stop = results.find((result) => result?.kind === "stop")
		if (stop?.kind === "stop") return stop.outcome
		const failed: string[] = []
		const evidence: Exchange[] = []
		for (const result of results) {
			if (result?.kind !== "failed") continue
			failed.push(result.line)
			if (evidence.length < 4) evidence.push(...result.evidence)
		}
		const lostAuth = results.some((result) => result?.kind === "lost-auth")
		if (narrowed !== null) {
			ctx.findings.gap(
				this.id,
				ctx.entityName,
				`${cases.length} of ${STRING_PAYLOADS.length} payload cases sent to "${field.name}"`,
				`the whole catalog already ran against this write path on ${narrowed}, so this field got one ` +
					'case of each family. Set `payloads: "full"` to send every case to every field.',
			)
		}

		if (lostAuth && failed.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"authentication failed in the middle of the payload catalog, so remaining cases were not run",
			)
		}
		if (failed.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a documented-valid string did not survive a write",
			`"${field.name}" failed ${failed.length} payload case(s): ${failed.slice(0, 6).join("; ")}` +
				(failed.length > 6 ? `; and ${failed.length - 6} more` : "") +
				". The document accepts these as strings; refusing or mutating them is silent corruption " +
				"or an undocumented constraint.",
			evidence,
		)
	},
}

/** Records one payload run fans its cases across. */
const PAYLOAD_LANES = 4

/**
 * The payload cases one field gets. Under `"per-write-path"`, the whole catalog runs once per
 * write path — the request media type and the field's type and format, which is what decides
 * the code a string goes through — and a field on a path that has had it gets one case of each
 * family. `narrowed` names the entity that ran the whole catalog, when this one did not.
 */
function payloadCases(
	ctx: CheckContext,
	writeOp: OperationModel,
	field: PayloadField,
): { cases: StringPayload[]; narrowed: string | null } {
	const fitting = STRING_PAYLOADS.filter((payload) => payloadFits(payload.value, field.maxLength, field.minLength))
	const policy = ctx.payloads
	if (policy === undefined || policy.policy === "full") return { cases: fitting, narrowed: null }
	const raw = ctx.model.rawOperations.get(writeOp.operationId)
	const mediaType = raw === undefined ? "" : (requestContent(raw)?.mediaType ?? "")
	const schema = propertySchemaOf(ctx, field.name, writeOp) ?? {}
	const path = `${mediaType}|${JSON.stringify([schema.type ?? "string", schema.format ?? null])}`
	const ranOn = policy.ran.get(path)
	if (ranOn === undefined) {
		policy.ran.set(path, ctx.entityName)
		return { cases: fitting, narrowed: null }
	}
	const representative = new Set<string>(REQUIRED_IDS)
	return { cases: fitting.filter((payload) => representative.has(payload.id)), narrowed: ranOn }
}

/** One line per operation: what it returned, and what the document declares. */
function describeUndeclared(
	ctx: CheckContext,
	byOp: Map<string, Exchange[]>,
): { lines: string[]; evidence: Exchange[] } {
	const lines: string[] = []
	const evidence: Exchange[] = []
	for (const [operationId, exchanges] of byOp) {
		const raw = ctx.model.rawOperations.get(operationId)
		const declared = Object.keys(raw?.responses ?? {})
			.filter((key) => key !== "default")
			.sort()
			.join(", ")
		const seen = [...new Set(exchanges.map((item) => item.status))].sort((a, b) => a - b)
		lines.push(`${operationId} returned ${seen.join(", ")}; the document declares ${declared || "no concrete status"}`)
		const first = exchanges[0]
		if (first !== undefined && evidence.length < 6) evidence.push(first)
	}
	return { evidence, lines }
}

function statusIsDeclared(raw: OperationObject | undefined, status: number): boolean {
	return documentsStatus(readStatuses(raw?.responses), status)
}

function declaresConcreteStatuses(raw: OperationObject | undefined): boolean {
	const statuses = readStatuses(raw?.responses)
	return statuses.exact.length > 0 || statuses.ranges.length > 0
}

/**
 * A 429 is a finding only when the request that drew it was demonstrably under a rate the
 * *document* declared — the rate came from `x-rate-limit` and the bucket had a free token, so oat
 * did not have to wait for one. A 429 against a config-supplied rate is the operator's own guess
 * about the environment, not a claim the API made, so it is paced around and never reported; a
 * 429 that only arrived after oat's own bucket made the request wait means oat's rate model was
 * too generous, which is oat's fault, not the backend's.
 *
 * Grouped by category rather than reported per request: the point is "the declared rate for X is
 * wrong", once, not one finding for every request that category serves.
 */
const declaredRateLimitHonoured: Check = {
	plan: (ctx) =>
		when(
			ctx.model.operations.some(
				(op) => op.entity === ctx.entityName && op.rateLimit !== null && op.rateLimit.rps !== null,
			),
		),
	id: "spec.declared-rate-limit-is-honoured",
	judgesTranscript: true,
	needs: "an operation on this entity with a rate declared by x-rate-limit",
	subjects: (entity, model) => ownOps(entity, model, (op) => op.rateLimit !== null && op.rateLimit.rps !== null),
	async run(ctx): Promise<Outcome> {
		const byCategory = new Map<string, Exchange[]>()
		for (const exchange of ctx.client.exchangesForEntity(ctx.entityName)) {
			if (exchange.status !== 429) continue
			if (exchange.rateLimitSource !== "tag" || exchange.rateLimitHadRoom !== true) continue
			const category = exchange.rateLimitCategory ?? "unknown"
			byCategory.set(category, [...(byCategory.get(category) ?? []), exchange])
		}
		for (const [category, exchanges] of byCategory) {
			ctx.findings.spec(
				this.id,
				ctx.entityName,
				`the declared "${category}" rate limit is not honoured`,
				`${exchanges.length} request(s) to the "${category}" category returned 429 despite oat ` +
					"pacing them within the rate x-rate-limit declares — each had a free token in its own " +
					"bucket at the moment it was sent, so this is not oat outrunning its own model. Either " +
					`the declared rate is wrong, or the backend enforces a stricter one than "${category}" ` +
					"documents.",
				exchanges.slice(0, 3),
			)
		}
		return ASSERTED
	},
}

const documentedStatusHonoured: Check = {
	plan: (ctx) => when(ctx.model.operations.some((op) => op.entity === ctx.entityName && op.action !== "create")),
	id: "response.status-is-documented",
	judgesTranscript: true,
	needs: "a modeled non-create operation on this entity",
	subjects: subjectsOf.nonCreate,
	async run(ctx): Promise<Outcome> {
		const createId = ctx.createOp?.operationId
		const byOp = new Map<string, Exchange[]>()
		const probes = new Map<string, Exchange[]>()
		const observed = new Set<string>()
		for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
			/* A documented feature-gate denial is told apart by its body. */
			const exchange = listed.status === 403 ? await ctx.client.hydrate(listed) : listed
			/* A status-0 network failure has no status to judge, and an answer that was asked again
			 * after a refresh or a wait is not the backend's verdict on the request. */
			if (exchange.status === 0 || exchange.superseded === true) continue
			const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
			if (op === undefined || op.entity !== ctx.entityName) continue
			if (!graded(ctx, op)) continue
			if (op.operationId === createId || op.action === "create") continue
			if (exchange.status === 429) continue
			const raw = ctx.model.rawOperations.get(op.operationId)
			if (!declaresConcreteStatuses(raw)) continue
			observed.add(op.operationId)
			if (isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) continue
			if (statusIsDeclared(raw, exchange.status)) continue
			/* A deliberately invalid request may draw a status the document never needed to name
			 * for real traffic. It is reported, but apart from what ordinary requests got. */
			const bucket = exchange.purpose === "probe" ? probes : byOp
			const seen = bucket.get(op.operationId) ?? []
			seen.push(exchange)
			bucket.set(op.operationId, seen)
		}
		ctx.judged?.([...observed])
		if (probes.size > 0) {
			const { lines, evidence } = describeUndeclared(ctx, probes)
			ctx.findings
				.attributed([...probes.keys()])
				.spec(
					this.id,
					ctx.entityName,
					"requests oat sent to be refused drew statuses the document does not declare",
					`${lines.join(". ")}. These were deliberately invalid probes, so the refusal is right; ` +
						"its status is what the document leaves out.",
					evidence,
				)
		}
		if (byOp.size === 0) return ASSERTED

		const { lines, evidence } = describeUndeclared(ctx, byOp)
		if (lines.length === 0) return ASSERTED
		return ctx.findings
			.attributed([...byOp.keys()])
			.spec(
				this.id,
				ctx.entityName,
				"an operation returned a status the document does not declare",
				`${lines.join(". ")}. Clients generated from this document will not recognise the response.`,
				evidence,
			)
	},
}

function pickFieldForOp(
	ctx: CheckContext,
	op: (typeof FILTER_OPS)[number],
	minDistinct = 2,
): { field: EffectiveFilterField; values: unknown[] } | null {
	for (const field of fieldsAllowing(ctx, op)) {
		const values = distinctValues(ctx.records, field.field)
		if (values.length >= minDistinct) return { field, values }
	}
	return null
}

function pickOrderedField(ctx: CheckContext): { field: EffectiveFilterField; values: number[] } | null {
	return cohortFact(ctx, "ordered", () => computePickOrderedField(ctx))
}

function computePickOrderedField(ctx: CheckContext): { field: EffectiveFilterField; values: number[] } | null {
	const caps = resolvedCaps(ctx)
	for (const field of caps.filterable) {
		if (field.type !== undefined && !ORDERED_TYPES.has(field.type)) continue
		if (!canUseOp(ctx, field, "gt") || !canUseOp(ctx, field, "lt") || !canUseOp(ctx, field, "eq")) continue
		const values = ctx.records.map((r) => r[field.field]).filter((v): v is number => typeof v === "number")
		if (values.length < 3) continue
		return { field, values }
	}
	return null
}

const FOUNDATIONS = [
	"list.read-after-write",
	"create.persists-submitted-fields",
	"pagination.page-walk-covers-set",
] as const

const filterInIsUnionOfEq: Check<{
	field: string
	a: unknown
	b: unknown
	inTerm: Record<string, string>
	eqA: Record<string, string>
	eqB: Record<string, string>
}> = {
	plan: (ctx) => {
		const picked = filterable(ctx) ? pickFieldForOp(ctx, "in", 2) : null
		const [a, b] = picked?.values ?? []
		if (picked === null || a === undefined || b === undefined) return cannot()
		const conventions = conv(ctx)
		const field = picked.field.field
		const inTerm = filterTerm(conventions, field, "in", [asTermValue(a), asTermValue(b)])
		const eqA = filterTerm(conventions, field, "eq", asTermValue(a))
		const eqB = filterTerm(conventions, field, "eq", asTermValue(b))
		if (inTerm === null || eqA === null || eqB === null) return cannot("a filter grammar that can express in and eq")
		return ready({ a, b, eqA, eqB, field, inTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.in-is-union-of-eq",
	needs: "a field that allows `in` and at least two distinct values",
	subjects: subjectsOf.list,
	async run(ctx, { a, b, eqA, eqB, field, inTerm }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const together = await collectSet(ctx, limit, inTerm)
		const onlyA = await collectSet(ctx, limit, eqA)
		const onlyB = await collectSet(ctx, limit, eqB)
		if (together === null || onlyA === null || onlyB === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for in() was rejected")
		}
		if (!together.complete || !onlyA.complete || !onlyB.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expected = new Set([...ids(onlyA.items, ctx.identity), ...ids(onlyB.items, ctx.identity)])
		const got = setOf(together.items, ctx.identity)
		if (sameSet(expected, got)) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"in() is not the union of the equalities it lists",
			`${field}.in.(${String(a)},${String(b)}) returned ${got.size} record(s); ` +
				`eq on each value together match ${expected.size}.`,
			[together.last.exchange, onlyA.last.exchange, onlyB.last.exchange],
		)
	},
}

const filterNinComplementsIn: Check<{
	field: string
	members: Array<string | number>
	inTerm: Record<string, string>
	ninTerm: Record<string, string>
}> = {
	plan: (ctx) => {
		if (!filterable(ctx)) return cannot()
		/* Two members where the cohort has them: a list of one cannot tell "every member" from
		 * "the first member" apart. */
		const picked = pickFieldForOp(ctx, "in", 2) ?? pickFieldForOp(ctx, "in", 1)
		if (picked === null || !canUseOp(ctx, picked.field, "nin")) return cannot()
		const members = picked.values.slice(0, 2).map(asTermValue)
		if (members.length === 0) return cannot()
		const conventions = conv(ctx)
		const field = picked.field.field
		const inTerm = filterTerm(conventions, field, "in", members)
		const ninTerm = filterTerm(conventions, field, "nin", members)
		if (inTerm === null || ninTerm === null) return cannot("a filter grammar that can express in and nin")
		return ready({ field, inTerm, members, ninTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.nin-complements-in",
	needs: "a field that allows both `in` and `nin`",
	subjects: subjectsOf.list,
	async run(ctx, { field, inTerm, ninTerm }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await collectSet(ctx, limit)
		const inside = await collectSet(ctx, limit, inTerm)
		const outside = await collectSet(ctx, limit, ninTerm)
		if (all === null || inside === null || outside === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for nin() was rejected")
		}
		if (!all.complete || !inside.complete || !outside.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const inIds = setOf(inside.items, ctx.identity)
		const ninIds = setOf(outside.items, ctx.identity)
		const overlap = [...inIds].filter((id) => ninIds.has(id))
		if (overlap.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"in() and nin() both match the same record",
				`${overlap.length} record(s) appear in both ${field}.in and .nin.`,
				[inside.last.exchange, outside.last.exchange],
			)
		}
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => String(row[ctx.identity]) === id)
			return record !== undefined && record[field] !== null && record[field] !== undefined
		})
		const union = new Set([...inIds, ...ninIds])
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"in() and nin() do not cover the non-null set",
			`${missing.length} non-null record(s) match neither side.`,
			[all.last.exchange, inside.last.exchange, outside.last.exchange],
		)
	},
}

const filterGteIsGtOrEq: Check<RangeProbe> = {
	plan: (ctx) => rangePlan(ctx, "gte", "gt"),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.equality-selects-exactly-one",
		"filter.numeric-comparison-is-numeric",
	],
	id: "filter.gte-is-gt-or-eq",
	needs: "an ordered field that allows `gte` and `gt`",
	subjects: subjectsOf.list,
	async run(ctx, probe): Promise<Outcome> {
		return assertRangeUnion(ctx, this.id, probe)
	},
}

const filterLteIsLtOrEq: Check<RangeProbe> = {
	plan: (ctx) => rangePlan(ctx, "lte", "lt"),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.equality-selects-exactly-one",
		"filter.numeric-comparison-is-numeric",
	],
	id: "filter.lte-is-lt-or-eq",
	needs: "an ordered field that allows `lte` and `lt`",
	subjects: subjectsOf.list,
	async run(ctx, probe): Promise<Outcome> {
		return assertRangeUnion(ctx, this.id, probe)
	},
}

/** A closed range, its open half, and equality, on one ordered field at one threshold. */
interface RangeProbe {
	field: string
	closed: "gte" | "lte"
	open: "gt" | "lt"
	threshold: number
	closedTerm: Record<string, string>
	openTerm: Record<string, string>
	eqTerm: Record<string, string>
}

function rangePlan(ctx: CheckContext, closed: "gte" | "lte", open: "gt" | "lt"): Plan<RangeProbe> {
	const picked = pickOrderedField(ctx)
	if (picked === null) return cannot()
	if (!canUseOp(ctx, picked.field, closed)) return cannot(`an ordered field that allows \`${closed}\``)
	const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 3)]
	if (threshold === undefined) return cannot()
	const field = picked.field.field
	const conventions = conv(ctx)
	const closedTerm = filterTerm(conventions, field, closed, threshold)
	const openTerm = filterTerm(conventions, field, open, threshold)
	const eqTerm = filterTerm(conventions, field, "eq", threshold)
	if (closedTerm === null || openTerm === null || eqTerm === null) {
		return cannot(`a filter grammar that can express ${closed}, ${open} and eq`)
	}
	return ready({ closed, closedTerm, eqTerm, field, open, openTerm, threshold })
}

async function assertRangeUnion(
	ctx: CheckContext,
	check: string,
	{ closed, closedTerm, eqTerm, field, open, openTerm, threshold }: RangeProbe,
): Promise<Outcome> {
	const limit = pageSize(ctx)
	const closedSet = await collectSet(ctx, limit, closedTerm)
	const openSet = await collectSet(ctx, limit, openTerm)
	const eqSet = await collectSet(ctx, limit, eqTerm)
	if (closedSet === null || openSet === null || eqSet === null) {
		return ctx.findings.unresolved(check, ctx.entityName, "one of the range listings was rejected")
	}
	if (!closedSet.complete || !openSet.complete || !eqSet.complete) {
		return ctx.findings.unresolved(check, ctx.entityName, "the collection is larger than the walk covers")
	}
	const expected = new Set([...ids(openSet.items, ctx.identity), ...ids(eqSet.items, ctx.identity)])
	const got = setOf(closedSet.items, ctx.identity)
	if (sameSet(expected, got)) return ASSERTED
	return ctx.findings.backend(
		check,
		ctx.entityName,
		`${closed} is not ${open} ∪ eq`,
		`${field}.${closed}.${threshold} returned ${got.size}; ${open} ∪ eq is ${expected.size}.`,
		[closedSet.last.exchange, openSet.last.exchange, eqSet.last.exchange],
	)
}

const filterOrderedTriplePartitions: Check<{
	field: string
	threshold: number
	lt: Record<string, string>
	eq: Record<string, string>
	gt: Record<string, string>
}> = {
	plan: (ctx) => {
		const picked = pickOrderedField(ctx)
		if (picked === null) return cannot()
		const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 2)]
		if (threshold === undefined) return cannot()
		const conventions = conv(ctx)
		const field = picked.field.field
		const lt = filterTerm(conventions, field, "lt", threshold)
		const eq = filterTerm(conventions, field, "eq", threshold)
		const gt = filterTerm(conventions, field, "gt", threshold)
		if (lt === null || eq === null || gt === null) return cannot("a filter grammar that can express lt, eq and gt")
		return ready({ eq, field, gt, lt, threshold })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.equality-selects-exactly-one",
		"filter.numeric-comparison-is-numeric",
	],
	id: "filter.ordered-triple-partitions",
	needs: "an ordered field that allows `lt`, `eq`, and `gt`",
	subjects: subjectsOf.list,
	async run(ctx, { eq, field, gt, lt }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await collectSet(ctx, limit)
		const lower = await collectSet(ctx, limit, lt)
		const equal = await collectSet(ctx, limit, eq)
		const higher = await collectSet(ctx, limit, gt)
		if (all === null || lower === null || equal === null || higher === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the triple listings was rejected")
		}
		if (!all.complete || !lower.complete || !equal.complete || !higher.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const sets = [setOf(lower.items, ctx.identity), setOf(equal.items, ctx.identity), setOf(higher.items, ctx.identity)]
		for (let i = 0; i < sets.length; i++) {
			for (let j = i + 1; j < sets.length; j++) {
				const left = sets[i]
				const right = sets[j]
				if (left === undefined || right === undefined) continue
				const overlap = [...left].filter((id) => right.has(id))
				if (overlap.length > 0) {
					return ctx.findings.backend(
						this.id,
						ctx.entityName,
						"lt / eq / gt are not pairwise disjoint",
						`${overlap.length} record(s) appear in more than one of ${field} lt/eq/gt.`,
						[lower.last.exchange, equal.last.exchange, higher.last.exchange],
					)
				}
			}
		}
		const union = new Set([...(sets[0] ?? []), ...(sets[1] ?? []), ...(sets[2] ?? [])])
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => String(row[ctx.identity]) === id)
			return record !== undefined && typeof record[field] === "number"
		})
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"lt ∪ eq ∪ gt does not cover the numeric set",
			`${missing.length} numeric record(s) match none of the three predicates.`,
			[all.last.exchange, lower.last.exchange, equal.last.exchange, higher.last.exchange],
		)
	},
}

const filterIlikeIsCaseInsensitive: Check<{
	field: EffectiveFilterField
	sample: string
	flipped: string
	likeTerm: Record<string, string>
	ilikeTerm: Record<string, string>
}> = {
	plan: (ctx) => {
		const field = fieldsAllowing(ctx, "ilike").find((item) => canUseOp(ctx, item, "like"))
		if (field === undefined) return cannot()
		const sample = ctx.records
			.map((row) => row[field.field])
			.find((value): value is string => typeof value === "string" && /[A-Za-z]/.test(value))
		if (sample === undefined) return cannot(`a cohort value of "${field.field}" holding a letter to case-flip`)
		const flipped = sample.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		const conventions = conv(ctx)
		const likeTerm = filterTerm(conventions, field.field, "like", flipped)
		const ilikeTerm = filterTerm(conventions, field.field, "ilike", flipped)
		if (likeTerm === null || ilikeTerm === null) return cannot("a filter grammar that can express like and ilike")
		return ready({ field, flipped, ilikeTerm, likeTerm, sample })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.like-metacharacters-escaped"],
	id: "filter.ilike-is-case-insensitive",
	needs: "a field that allows both `ilike` and `like`, and a string with a letter",
	subjects: subjectsOf.list,
	async run(ctx, { field, flipped, ilikeTerm, likeTerm, sample }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const like = await listAll(ctx, { ...q(ctx, { limit }), ...likeTerm })
		const ilike = await listAll(ctx, { ...q(ctx, { limit }), ...ilikeTerm })
		if (like.exchange.status >= 400 || ilike.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "like/ilike probe was rejected")
		}
		if (!like.complete || !ilike.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		const likeHits = ids(like.items, ctx.identity)
		const ilikeHits = ids(ilike.items, ctx.identity)
		const original = ctx.records.filter((row) => row[field.field] === sample).map((row) => String(row[ctx.identity]))
		if (original.some((id) => ilikeHits.includes(id)) && !original.some((id) => likeHits.includes(id))) return ASSERTED
		if (original.some((id) => ilikeHits.includes(id)) && original.some((id) => likeHits.includes(id))) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"like also matched the case-flipped value — the store may already be case-insensitive",
			)
		}
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"ilike is not case-insensitive relative to like",
			`ilike on ${JSON.stringify(flipped)} did not select the record whose ${field.field} is ${JSON.stringify(sample)}.`,
			[like.exchange, ilike.exchange],
		)
	},
}

function mixedNullField(ctx: CheckContext, field: string): boolean {
	if (ctx.softDelete !== null && field === ctx.softDelete) return false
	return holdsSomeNulls(ctx, field)
}

const filterIsNullSelectsNulls: Check<{
	field: EffectiveFilterField
	nullTerm: Record<string, string>
	notNullTerm: Record<string, string>
}> = {
	plan: (ctx) => {
		const field = fieldsAllowing(ctx, "is").find((item) => mixedNullField(ctx, item.field))
		if (field === undefined) return cannot()
		const conventions = conv(ctx)
		const nullTerm = filterTerm(conventions, field.field, "is", "null")
		const notNullTerm = filterTerm(conventions, field.field, "is", "notnull")
		if (nullTerm === null || notNullTerm === null) return cannot("a filter grammar that can express is.null")
		return ready({ field, notNullTerm, nullTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS],
	id: "filter.is-null-selects-nulls",
	needs: "a field that allows `is` and a cohort that contains a null",
	subjects: subjectsOf.list,
	async run(ctx, { field, notNullTerm, nullTerm }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await collectSet(ctx, limit)
		const nulls = await collectSet(ctx, limit, nullTerm)
		const present = await collectSet(ctx, limit, notNullTerm)
		if (all === null || nulls === null || present === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "an is.null / is.notnull listing was rejected")
		}
		if (!all.complete || !nulls.complete || !present.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expectedNulls = new Set(
			ctx.records
				.filter((row) => row[field.field] === null || row[field.field] === undefined)
				.map((row) => String(row[ctx.identity])),
		)
		const gotNulls = knownHits(nulls.items, ctx)
		const overlap = [...gotNulls].filter((id) => knownHits(present.items, ctx).has(id))
		if (!sameSet(expectedNulls, gotNulls) || overlap.length > 0) {
			ctx.findings.backend(
				this.id,
				ctx.entityName,
				"is.null / is.notnull do not partition on nulls",
				`is.null returned ${gotNulls.size} record(s); ${expectedNulls.size} cohort rows are null. ` +
					(overlap.length > 0 ? `${overlap.length} appear on both sides.` : ""),
				[nulls.last.exchange, present.last.exchange],
			)
		}
		return ASSERTED
	},
}

/** An array field membership can be asked of, with a known element — one rule for both phases. */
function containsField(ctx: CheckContext): EffectiveFilterField | undefined {
	return resolvedCaps(ctx).filterable.find(
		(field) =>
			(field.type === "array" ||
				schemaType(ctx, field.field) === "array" ||
				fieldAllows(field, "contains", resolvedCaps(ctx))) &&
			canWriteFilterOp(conv(ctx), "contains") &&
			ctx.records.some((row) => Array.isArray(row[field.field]) && (row[field.field] as unknown[]).length > 0),
	)
}

const filterContainsMembership: Check<{ field: EffectiveFilterField; element: string; term: Record<string, string> }> =
	{
		plan: (ctx) => {
			const field = containsField(ctx)
			if (field === undefined) return cannot()
			/* The most telling element is one that also occurs inside another element's text: an
			 * implementation matching the serialised array instead of its members over-selects there. */
			const elements = [
				...new Set(
					ctx.records.flatMap((row) => (Array.isArray(row[field.field]) ? (row[field.field] as unknown[]) : [])),
				),
			].map(String)
			const element =
				elements.find((candidate) => elements.some((other) => other !== candidate && other.includes(candidate))) ??
				elements[0]
			if (element === undefined) return cannot(`a cohort record whose "${field.field}" holds an element`)
			const term = filterTerm(conv(ctx), field.field, "contains", asTermValue(element))
			return term === null ? cannot("a filter grammar with a contains operator") : ready({ element, field, term })
		},
		dependsOn: [...FOUNDATIONS, "query.filter-selects-from-whole-set"],
		id: "filter.contains-membership",
		needs: "an array field that allows `contains` and a known element",
		subjects: subjectsOf.list,
		async run(ctx, { element, field, term }): Promise<Outcome> {
			const result = await collectSet(ctx, pageSize(ctx), term)
			if (result === null) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "contains probe was rejected")
			}
			if (!result.complete) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
			}
			const expected = new Set(
				ctx.records
					.filter(
						(row) =>
							Array.isArray(row[field.field]) &&
							(row[field.field] as unknown[]).some((item) => String(item) === String(element)),
					)
					.map((row) => String(row[ctx.identity])),
			)
			const got = knownHits(result.items, ctx)
			if (sameSet(expected, got)) return ASSERTED
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"contains does not select membership of the given element",
				`${field.field}.contains.${String(element)} returned ${got.size}; ${expected.size} records hold that element.`,
				[result.last.exchange],
			)
		},
	}

const filterNestedAndOrDistributes: Check<{
	nested: Record<string, string>
	termA: Record<string, string>
	termB: Record<string, string>
	termC: Record<string, string>
}> = {
	plan: (ctx) => {
		if (conv(ctx).grammar !== "postgrest" || filterableNames(ctx).length <= 1) return cannot()
		const picked = twoFilterableFields(ctx)
		if (picked === null) return cannot("a cohort record with values on two distinct filterable fields")
		const idField = filterIdentity(ctx)
		if (idField === picked.fieldA || idField === picked.fieldB || !identityIsFilterable(ctx)) {
			return cannot("a filterable identity as a third term to nest and/or")
		}
		const conventions = conv(ctx)
		const fragA = filterFragment(conventions, picked.fieldA, String(picked.target[picked.fieldA]))
		const fragB = filterFragment(conventions, picked.fieldB, String(picked.target[picked.fieldB]))
		const fragC = filterFragment(conventions, idField, String(picked.target[ctx.identity]))
		const termA = filterTerm(conventions, picked.fieldA, "eq", String(picked.target[picked.fieldA]))
		const termB = filterTerm(conventions, picked.fieldB, "eq", String(picked.target[picked.fieldB]))
		const termC = filterTerm(conventions, idField, "eq", String(picked.target[ctx.identity]))
		if (fragA === null || fragB === null || fragC === null || conventions.filter === undefined) return cannot()
		if (termA === null || termB === null || termC === null) return cannot()
		const nested = { [conventions.filter]: `and(${fragA},or(${fragB},${fragC}))` }
		return ready({ nested, termA, termB, termC })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.and-composes-as-intersection",
		"filter.or-composes-as-union",
	],
	id: "filter.nested-and-or-distributes",
	needs: "a postgrest-shaped grammar and two filterable fields",
	subjects: subjectsOf.list,
	async run(ctx, { nested, termA, termB, termC }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const onlyA = await collectSet(ctx, limit, termA)
		const onlyB = await collectSet(ctx, limit, termB)
		const onlyC = await collectSet(ctx, limit, termC)
		const combined = await collectSet(ctx, limit, nested)
		if (onlyA === null || onlyB === null || onlyC === null || combined === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a nested and/or listing was rejected")
		}
		if (!onlyA.complete || !onlyB.complete || !onlyC.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		const setC = setOf(onlyC.items, ctx.identity)
		const expected = new Set([...setA].filter((id) => setB.has(id) || setC.has(id)))
		const got = setOf(combined.items, ctx.identity)
		if (sameSet(expected, got)) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and(A,or(B,C)) is not (A∩B) ∪ (A∩C)",
			`nested combinator returned ${got.size}; the distributed form is ${expected.size}.`,
			[combined.last.exchange, onlyA.last.exchange, onlyB.last.exchange, onlyC.last.exchange],
		)
	},
}

const filterAliasMatchesCanonical: Check = {
	plan: (ctx) => when(Object.keys(resolvedCaps(ctx).aliases).length > 0 && filterable(ctx)),
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.alias-matches-canonical",
	needs: "a declared filter operator alias",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const caps = resolvedCaps(ctx)
		const conventions = conv(ctx)
		const limit = pageSize(ctx)
		for (const [alias, target] of Object.entries(caps.aliases)) {
			if (!isFilterOp(alias) || target === undefined) continue
			const field = resolvedCaps(ctx).filterable.find((item) => fieldAllows(item, target, caps))
			if (field === undefined || !canWriteFilterOp(conventions, alias)) continue
			const sample = ctx.records.find((row) => row[field.field] != null)
			if (sample === undefined) continue
			const value = asTermValue(sample[field.field])
			const aliasTerm = filterTerm(conventions, field.field, alias, value)
			const targetTerm = filterTerm(conventions, field.field, target, value)
			if (aliasTerm === null || targetTerm === null) continue
			const left = await collectSet(ctx, limit, aliasTerm)
			const right = await collectSet(ctx, limit, targetTerm)
			if (left === null || right === null) {
				return ctx.findings.unresolved(this.id, ctx.entityName, `alias ${alias} or ${target} was rejected`)
			}
			if (!left.complete || !right.complete) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
			}
			if (!sameSet(setOf(left.items, ctx.identity), setOf(right.items, ctx.identity))) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					`alias ${alias} does not select the same set as ${target}`,
					`${field.field}.${alias} and ${field.field}.${target} disagreed on membership.`,
					[left.last.exchange, right.last.exchange],
				)
			}
		}
		return ASSERTED
	},
}

function firstIllegalOp(ctx: CheckContext, field: EffectiveFilterField): (typeof FILTER_OPS)[number] | undefined {
	const caps = resolvedCaps(ctx)
	if (!opsAreClosed(field, caps)) return undefined
	const allowed = new Set(opsForField(field, caps))
	/* An alias spells an allowed operator another way (`ne` for `neq`): it is not illegal. */
	const permitted = (op: (typeof FILTER_OPS)[number]): boolean => {
		const target = caps.aliases[op]
		return allowed.has(op) || (target !== undefined && allowed.has(target))
	}
	return FILTER_OPS.find((op) => !permitted(op) && canWriteFilterOp(conv(ctx), op))
}

type IllegalOpProbe = {
	field: EffectiveFilterField
	op: (typeof FILTER_OPS)[number]
	term: Record<string, string>
	/** The same field under an operator it allows: the control that the field itself is accepted. */
	control: Record<string, string>
}

const filterIllegalOpRejected: Check<{ probes: IllegalOpProbe[] }> = {
	plan: (ctx) => {
		const probes: IllegalOpProbe[] = []
		for (const field of resolvedCaps(ctx).filterable) {
			const op = firstIllegalOp(ctx, field)
			if (op === undefined) continue
			const sample = ctx.records.find((row) => row[field.field] != null)
			const value = sample === undefined ? "oat-probe" : asTermValue(sample[field.field])
			const legal = opsForField(field, resolvedCaps(ctx)).find((allowed) => canWriteFilterOp(conv(ctx), allowed))
			const term = filterTerm(conv(ctx), field.field, op, value)
			const control =
				legal === undefined ? null : filterTerm(conv(ctx), field.field, legal as (typeof FILTER_OPS)[number], value)
			if (term !== null && control !== null) probes.push({ control, field, op, term })
		}
		return probes.length === 0 ? cannot() : ready({ probes })
	},
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected", "error.malformed-filter-not-5xx"],
	id: "filter.illegal-op-rejected",
	needs: "a field with a closed operator list",
	subjects: subjectsOf.list,
	async run(ctx, { probes }): Promise<Outcome> {
		/* A refusal proves the operator is policed only when the field itself is accepted: a field
		 * the backend will not filter on at all refuses every operator, illegal or not. */
		let picked: IllegalOpProbe | undefined
		for (const probe of probes) {
			const control = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...probe.control })
			if (control.exchange.status < 400) {
				picked = probe
				break
			}
		}
		if (picked === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no field with a closed operator list accepted even an operator it allows",
			)
		}
		const { field, op, term } = picked
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an illegal filter operator produces a server error",
				`${field.field}.${op} returned ${result.exchange.status}; a rejected operator should be 4xx.`,
				[result.exchange],
			)
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an illegal filter operator is accepted",
			`${field.field}.${op} returned ${result.exchange.status}` +
				(same ? " with the unfiltered set, so the operator was ignored" : "") +
				". A closed operator list is a contract: anything outside it must be rejected.",
			[baseline.exchange, result.exchange],
		)
	},
}

const filterEmptyIn: Check<{
	field: string
	policy: NonNullable<EffectiveQueryCapabilities["emptyIn"]>
	term: Record<string, string>
}> = {
	plan: (ctx) => {
		const picked = pickFieldForOp(ctx, "in", 1)
		const policy = resolvedCaps(ctx).emptyIn
		if (picked === null || policy === undefined) return cannot()
		const term = filterTerm(conv(ctx), picked.field.field, "in", [])
		return term === null
			? cannot("a filter grammar that can express an empty in()")
			: ready({ field: picked.field.field, policy, term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.empty-in",
	needs: "`emptyIn` declared and a field that allows `in`",
	subjects: subjectsOf.list,
	async run(ctx, { field, policy, term }): Promise<Outcome> {
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"empty in() was not rejected",
				`emptyIn=reject but ${field}.in.() returned ${result.exchange.status}.`,
				[result.exchange],
			)
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty in() was rejected under match-none")
		}
		if (result.items.length === 0) return ASSERTED
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"empty in() did not match none",
			`emptyIn=match-none but ${field}.in.() returned ${result.items.length} record(s)` +
				(same ? " — the unfiltered set, so the filter was ignored" : "") +
				".",
			[baseline.exchange, result.exchange],
		)
	},
}

const filterInOverLimitRejected: Check<{ field: string; max: number; term: Record<string, string> }> = {
	plan: (ctx) => {
		const max = resolvedCaps(ctx).maxInValues
		const picked = pickFieldForOp(ctx, "in", 1)
		if (max === undefined || picked === null) return cannot()
		const members = Array.from({ length: max + 1 }, (_, i) => `oat-over-limit-${i}`)
		const term = filterTerm(conv(ctx), picked.field.field, "in", members)
		return term === null
			? cannot("a filter grammar that can express in()")
			: ready({ field: picked.field.field, max, term })
	},
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.in-over-limit-rejected",
	needs: "`maxInValues` declared and a field that allows `in`",
	subjects: subjectsOf.list,
	async run(ctx, { field, max, term }): Promise<Outcome> {
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), ...term })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit in() list was accepted",
			`maxInValues=${max} but ${field}.in with ${max + 1} members returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
}

const filterConditionCapRejected: Check<{ max: number; parameter: string }> = {
	plan: (ctx) => {
		const max = resolvedCaps(ctx).maxFilterConditions
		const parameter = conv(ctx).filter
		if (max === undefined || parameter === undefined) return cannot()
		if (conv(ctx).grammar !== "postgrest" || !identityIsFilterable(ctx)) return cannot()
		return ready({ max, parameter })
	},
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.condition-cap-rejected",
	needs: "`maxFilterConditions` declared and a grammar that can group eq terms",
	subjects: subjectsOf.list,
	async run(ctx, { max, parameter }): Promise<Outcome> {
		const field = filterIdentity(ctx)
		const terms = Array.from({ length: max + 1 }, () => `${field}.eq.oat-cap`)
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), [parameter]: `and(${terms.join(",")})` })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit filter expression was accepted",
			`maxFilterConditions=${max} but ${max + 1} eq terms returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
}

/** The JSON type the item schema gives a property, looking through a nullable union. */
function schemaType(ctx: CheckContext, field: string): string | undefined {
	const properties = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
	const declared = properties[field]
	if (declared === undefined) return undefined
	const branches = [declared, ...((declared.oneOf ?? declared.anyOf ?? []) as Array<Record<string, unknown>>)]
	for (const branch of branches) {
		const type = branch.type
		if (typeof type === "string" && type !== "null") return type
		if (Array.isArray(type)) {
			const named = type.find((item) => item !== "null")
			if (typeof named === "string") return named
		}
	}
	return undefined
}

/**
 * An operator the field allows and a value of the field's own type, to ask whether a declared
 * filter exists at all. Equality where it is allowed; membership for an array.
 */
function capabilityProbe(
	ctx: CheckContext,
	name: string,
): { op: (typeof FILTER_OPS)[number]; value: string | number | boolean } | null {
	const caps = resolvedCaps(ctx)
	const field = caps.filterable.find((item) => item.field === name) ?? { field: name }
	const type = field.type ?? schemaType(ctx, name)
	const sample = ctx.records.find((record) => record[name] !== null && record[name] !== undefined)?.[name]
	if (type === "array") {
		if (!canUseOp(ctx, field, "contains")) return null
		const element = Array.isArray(sample) ? sample[0] : undefined
		if (element !== undefined) return { op: "contains", value: asTermValue(element) }
		const items = (
			ctx.listOp.collection?.itemSchema?.properties as Record<string, Record<string, unknown>> | undefined
		)?.[name]?.items
		const sentinel = filterSentinel(items ?? { type: "string" }, ctx.nonce ?? "oat")
		return sentinel.ok ? { op: "contains", value: asTermValue(sentinel.value) } : null
	}
	if (!canUseOp(ctx, field, "eq")) return null
	if (sample !== undefined && typeof sample !== "object") return { op: "eq", value: asTermValue(sample) }
	const declared = (ctx.listOp.collection?.itemSchema?.properties as Record<string, unknown> | undefined)?.[name]
	const sentinel = filterSentinel(declared ?? { type: type ?? "string" }, ctx.nonce ?? "oat")
	if (
		sentinel.ok &&
		(typeof sentinel.value === "string" || typeof sentinel.value === "number" || typeof sentinel.value === "boolean")
	) {
		return { op: "eq", value: sentinel.value }
	}
	return null
}

function probeValueForOp(
	ctx: CheckContext,
	field: EffectiveFilterField,
	op: (typeof FILTER_OPS)[number],
): string | number | readonly (string | number)[] | null {
	const sample = ctx.records.find((row) => row[field.field] != null)
	if (op === "is") return "null"
	if (op === "contains") {
		const arr = sample?.[field.field]
		if (Array.isArray(arr) && arr[0] !== undefined) return asTermValue(arr[0])
		return "oat-probe"
	}
	/* A value of the field's own type: a backend that rejects a string compared with a date is
	 * right to, and that says nothing about whether the operator is supported. */
	const value = sample === undefined ? typedSentinel(ctx, field) : asTermValue(sample[field.field])
	if (value === null) return null
	return op === "in" || op === "nin" ? [value] : value
}

/** A well-formed value of `field`'s declared type that no record holds, for probing a capability. */
function typedSentinel(ctx: CheckContext, field: EffectiveFilterField): string | number | null {
	const declared = (ctx.listOp.collection?.itemSchema?.properties as Record<string, unknown> | undefined)?.[field.field]
	const made = filterSentinel(declared ?? { type: field.type ?? schemaType(ctx, field.field) ?? "string" }, ctx.nonce)
	return made.ok && (typeof made.value === "string" || typeof made.value === "number") ? made.value : null
}

/**
 * How a backend answered a request exercising something the document declares. Only 400 and
 * 422 say "this is not supported"; 401, 403, 404 and 429 turn the request away before the
 * capability is ever consulted, and a 5xx is a crash, not a refusal.
 */
function declarationAnswer(status: number): "accepted" | "refused" | "unknown" {
	if (status > 0 && status < 400) return "accepted"
	return status === 400 || status === 422 ? "refused" : "unknown"
}

const declaredFilterableOpsAccepted: Check = {
	plan: (ctx) =>
		when(
			ctx.query?.source === "tag" &&
				resolvedCaps(ctx).filterable.some((field) => opsAreClosed(field, resolvedCaps(ctx))),
		),
	dependsOn: ["list.read-after-write", "spec.declared-filterable-is-filterable", "error.malformed-filter-not-5xx"],
	id: "spec.declared-filterable-ops-accepted",
	needs: "a closed operator list on at least one declared field",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const caps = resolvedCaps(ctx)
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		const probes: Array<{ label: string; term: Record<string, string> }> = []
		for (const field of caps.filterable) {
			if (!opsAreClosed(field, caps)) continue
			for (const op of opsForField(field, caps)) {
				if (!canWriteFilterOp(conv(ctx), op)) continue
				const term = filterTerm(conv(ctx), field.field, op, probeValueForOp(ctx, field, op))
				if (term !== null) probes.push({ label: `${field.field}.${op}`, term })
			}
		}
		/* Every operator at once; the answers are judged in declaration order. */
		const results = await Promise.all(probes.map((probe) => list(ctx, { ...q(ctx, { limit: 5 }), ...probe.term })))
		for (const [index, result] of results.entries()) {
			const label = probes[index]?.label ?? "?"
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") {
				refusedBy.push(result.exchange)
				rejected.push(`${label} (${result.exchange.status})`)
			}
			if (answer === "unknown") unknown.push(`${label} (${result.exchange.status})`)
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED
		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a filter operator the backend rejects",
			`declared ops that 4xx: ${rejected.slice(0, 8).join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
}

const sortUnknownFieldRejected: Check = {
	plan: (ctx) => when(conv(ctx).order !== undefined),
	dependsOn: ["error.malformed-filter-not-5xx"],
	id: "sort.unknown-field-rejected",
	needs: "an order parameter",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(
			asProbe(ctx),
			q(ctx, { limit: 5, order: sortTerm(conv(ctx), "oat_no_such_sort_xyz", "asc") }),
		)
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown sort field produces a server error",
				`ordering on an undeclared field returned ${result.exchange.status}; a rejected input should be 4xx.`,
				[result.exchange],
			)
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const baseline = await list(ctx, q(ctx, { limit: 5 }))
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown sort field is silently ignored",
			`order on an undeclared field returned ${result.exchange.status}` +
				(same ? " with the default order, so the field was dropped" : "") +
				".",
			[baseline.exchange, result.exchange],
		)
	},
}

const sortNumericOrderIsNumeric: Check<{ field: EffectiveFilterField }> = {
	plan: (ctx) => {
		const field = resolvedCaps(ctx).sortable.find((item) => numericLexicalDisagrees(ctx, item.field))
		return conv(ctx).order === undefined || field === undefined ? cannot() : ready({ field })
	},
	dependsOn: ["sort.order-is-applied", "pagination.page-walk-covers-set"],
	id: "sort.numeric-order-is-numeric",
	needs: "a numeric sortable field whose lexical order disagrees with numeric order",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		/* Across pages: a server that serves a few rows at a time can put the disagreeing values on
		 * different pages. Even a read cut short is a prefix of the order, and must ascend. */
		const read = await readSet(ctx, {}, { order: sortTerm(conv(ctx), field.field, "asc") })
		if (read.status !== "ok")
			return ctx.findings.unresolved(this.id, ctx.entityName, read.reason ?? "the sorted listing was rejected")
		const numbers = read.items.map((item) => item[field.field]).filter((v): v is number => typeof v === "number")
		const sorted = [...numbers].sort((a, b) => a - b)
		if (numbers.join(",") === sorted.join(",")) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			`"${field.field}" is sorted as text rather than as a number`,
			`order=${field.field}.asc returned ${numbers.slice(0, 8).join(", ")}.`,
			read.pages.slice(0, 3).map((page) => page.exchange),
		)
	},
}

const sortNullsFirstLast: Check<{
	field: EffectiveFilterField
	firstClause: string | null
	lastClause: string | null
}> = {
	plan: (ctx) => {
		if (conv(ctx).order === undefined || sortTermWithNulls(conv(ctx), "x", "asc", "first") === null) return cannot()
		const field = resolvedCaps(ctx).sortable.find(
			(item) =>
				(fieldAllowsNulls(item, resolvedCaps(ctx), "first") || fieldAllowsNulls(item, resolvedCaps(ctx), "last")) &&
				ctx.records.some((row) => row[item.field] === null || row[item.field] === undefined),
		)
		if (field === undefined) return cannot()
		const placed = (where: "first" | "last"): string | null =>
			fieldAllowsNulls(field, resolvedCaps(ctx), where) ? sortTermWithNulls(conv(ctx), field.field, "asc", where) : null
		const firstClause = placed("first")
		const lastClause = placed("last")
		if (firstClause === null && lastClause === null) return cannot("a sort grammar that can place nulls")
		return ready({ field, firstClause, lastClause })
	},
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.nulls-first-last",
	needs: "a declared nulls token, a dotted sort grammar, and a null in the cohort",
	subjects: subjectsOf.list,
	async run(ctx, { field, firstClause, lastClause }): Promise<Outcome> {
		const limit = pageSize(ctx)
		if (firstClause !== null) {
			const clause = firstClause
			const result = await collectSet(ctx, limit, {}, clause)
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullsfirst listing was rejected")
			const first = result.items[0]
			if (first !== undefined && first[field.field] !== null && first[field.field] !== undefined) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullsfirst did not put nulls first",
					`order=${clause} started with ${JSON.stringify(first[field.field])}.`,
					[result.last.exchange],
				)
			}
		}
		if (lastClause !== null) {
			const clause = lastClause
			const result = await collectSet(ctx, limit, {}, clause)
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullslast listing was rejected")
			/* The last record of a partial walk is not the last record of the set. */
			if (!result.complete) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
			}
			const last = result.items.at(-1)
			if (last !== undefined && last[field.field] !== null && last[field.field] !== undefined) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullslast did not put nulls last",
					`order=${clause} ended with ${JSON.stringify(last[field.field])}.`,
					[result.last.exchange],
				)
			}
		}
		return ASSERTED
	},
}

function pickMultiKeyPair(ctx: CheckContext): { primary: string; secondary: string; tied: Record_[] } | null {
	return cohortFact(ctx, "multi-key", () => computePickMultiKeyPair(ctx))
}

function computePickMultiKeyPair(ctx: CheckContext): { primary: string; secondary: string; tied: Record_[] } | null {
	const fields = ctx.query?.sortable ?? []
	for (const primary of fields) {
		for (const secondary of fields) {
			if (secondary === primary || secondary === ctx.identity) continue
			const groups = new Map<string, Record_[]>()
			for (const row of ctx.records) {
				const key = JSON.stringify(row[primary])
				const group = groups.get(key) ?? []
				group.push(row)
				groups.set(key, group)
			}
			const tied = [...groups.values()].find(
				(group) => group.length >= 2 && new Set(group.map((row) => JSON.stringify(row[secondary]))).size > 1,
			)
			if (tied !== undefined) return { primary, secondary, tied }
		}
	}
	return null
}

const sortMultiKeyTiebreak: Check<{ primary: string; secondary: string; tied: Record_[] }> = {
	plan: (ctx) => {
		const max = resolvedCaps(ctx).sort?.maxKeys
		if (conv(ctx).order === undefined || (max !== undefined && max < 2)) return cannot()
		const pair = pickMultiKeyPair(ctx)
		return pair === null ? cannot() : ready(pair)
	},
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.multi-key-tiebreak",
	needs: "two sortable fields and rows that tie on the first and differ on the second",
	subjects: subjectsOf.list,
	async run(ctx, { primary, secondary, tied }): Promise<Outcome> {
		const conventions = conv(ctx)
		/* The second key descending: whatever tiebreak a server applies on its own runs ascending,
		 * and asking for the same field ascending would let that accident pass for a second key. */
		const order = `${sortTerm(conventions, primary, "asc")},${sortTerm(conventions, secondary, "desc")}`
		const result = await collectSet(ctx, pageSize(ctx), {}, order)
		if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "multi-key order was rejected")
		const slice = result.items.filter((item) => JSON.stringify(item[primary]) === JSON.stringify(tied[0]?.[primary]))
		const seconds = slice.map((item) => item[secondary]).reverse()
		if (sortedUnder(ctx, secondary, seconds) !== null) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"the second sort key is not applied on ties",
			`order=${order} left ties on "${primary}" unordered by "${secondary}".`,
			[result.last.exchange],
		)
	},
}

const sortDefaultOrderApplied: Check<{ declared: string }> = {
	plan: (ctx) => {
		const declared = resolvedCaps(ctx).sort?.defaultOrder ?? ctx.query?.defaultOrder
		return declared === undefined || ctx.records.length <= 1 ? cannot() : ready({ declared })
	},
	dependsOn: ["sort.order-is-applied", "pagination.page-walk-covers-set"],
	id: "sort.default-order-applied",
	needs: "a declared defaultOrder and a complete walk",
	subjects: subjectsOf.list,
	async run(ctx, { declared }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const implicit = await collectSet(ctx, limit)
		const explicit = await collectSet(ctx, limit, {}, declared)
		if (implicit === null || explicit === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "default-order walk was rejected")
		}
		if (!implicit.complete || !explicit.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the walk is incomplete, so default order cannot be compared",
			)
		}
		if (ids(implicit.items, ctx.identity).join(",") === ids(explicit.items, ctx.identity).join(",")) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"omitting order does not match defaultOrder",
			`defaultOrder=${declared} produced a different sequence than the implicit listing.`,
			[implicit.last.exchange, explicit.last.exchange],
		)
	},
}

const sortStableTiebreak: Check<{ primary: string; tiebreak: string }> = {
	plan: (ctx) => {
		const tiebreak = resolvedCaps(ctx).sort?.stableTiebreak ?? ctx.query?.stableTiebreak
		if (tiebreak === undefined) return cannot()
		/* Only ties exercise a tiebreak: on distinct keys every implementation looks stable. */
		const primary = tiedSortField(ctx)
		if (primary === null || primary === tiebreak) return cannot("a sortable field with tied values in the cohort")
		return ready({ primary, tiebreak })
	},
	dependsOn: ["pagination.page-walk-covers-set", "sort.order-is-applied"],
	id: "sort.stable-tiebreak",
	needs: "a declared stableTiebreak and a tie on the primary key",
	subjects: subjectsOf.list,
	async run(ctx, { primary, tiebreak }): Promise<Outcome> {
		const order = sortTerm(conv(ctx), primary, "asc")
		/* Two independent reads: a shared one would compare a walk with itself. */
		const first = await readSet(ctx, {}, { fresh: true, order })
		const second = await readSet(ctx, {}, { fresh: true, order })
		if (first.status !== "ok" || second.status !== "ok")
			return ctx.findings.unresolved(this.id, ctx.entityName, "repeat sort was rejected")
		if (ids(first.items, ctx.identity).join(",") !== ids(second.items, ctx.identity).join(",")) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"the same order is not deterministic across two walks",
				`order=${order} (stableTiebreak=${tiebreak}) returned two different sequences.`,
				[first.last.exchange, second.last.exchange],
			)
		}
		/* Within a run of equal keys the declared tiebreak decides the order, so its values must
		 * move one way. Which way is the backend's to choose; moving both ways is no tiebreak. */
		const broken: string[] = []
		let run: Record_[] = []
		const flush = (): void => {
			const values = run.map((row) => row[tiebreak]).filter((value) => value !== null && value !== undefined)
			const rising = values.every((value, i) => i === 0 || compareScalars(values[i - 1], value) <= 0)
			const falling = values.every((value, i) => i === 0 || compareScalars(values[i - 1], value) >= 0)
			if (!rising && !falling) broken.push(JSON.stringify(run[0]?.[primary]))
			run = []
		}
		for (const row of first.items) {
			if (run.length > 0 && JSON.stringify(run[0]?.[primary]) !== JSON.stringify(row[primary])) flush()
			run.push(row)
		}
		flush()
		if (broken.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"ties are not broken by the declared tiebreak",
			`order=${order} returned records tied on ${primary} (${broken.slice(0, 3).join(", ")}) in an ` +
				`order the declared stableTiebreak "${tiebreak}" does not explain. Pagination over such an ` +
				"order can repeat or drop records at a page boundary.",
			[first.last.exchange],
		)
	},
}

const declaredSortableNullsAccepted: Check = {
	plan: (ctx) =>
		when(
			conv(ctx).order !== undefined &&
				sortTermWithNulls(conv(ctx), "x", "asc", "first") !== null &&
				resolvedCaps(ctx).sortable.some(
					(field) =>
						fieldAllowsNulls(field, resolvedCaps(ctx), "first") || fieldAllowsNulls(field, resolvedCaps(ctx), "last"),
				),
		),
	dependsOn: ["sort.order-is-applied"],
	id: "spec.declared-sortable-nulls-accepted",
	needs: "a declared nulls token on a sortable field",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		for (const field of resolvedCaps(ctx).sortable) {
			for (const token of ["first", "last"] as const) {
				if (!fieldAllowsNulls(field, resolvedCaps(ctx), token)) continue
				const clause = sortTermWithNulls(conv(ctx), field.field, "asc", token)
				if (clause === null) continue
				const result = await list(ctx, q(ctx, { limit: 5, order: clause }))
				const answer = declarationAnswer(result.exchange.status)
				if (answer === "refused") {
					refusedBy.push(result.exchange)
					rejected.push(`${clause} (${result.exchange.status})`)
				}
				if (answer === "unknown") unknown.push(`${clause} (${result.exchange.status})`)
			}
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED
		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a nulls sort token the backend rejects",
			`rejected: ${rejected.join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
}

const searchTokensAnd: Check<{ a: string; b: string }> = {
	plan: (ctx) => {
		const field = ctx.query?.searchable[0]
		if (conv(ctx).search === undefined || field === undefined || ctx.records.length <= 2) return cannot()
		const tokens: string[] = []
		for (const row of ctx.records) {
			const value = row[field]
			if (typeof value !== "string") continue
			/* As written: lowercasing it would match nothing on a case-sensitive search, and two
			 * empty sides agree vacuously. */
			const word = value.split(/\s+/).find((part) => part.length >= 3)
			if (word !== undefined) tokens.push(word)
		}
		const [a, b] = [...new Set(tokens)]
		return a === undefined || b === undefined
			? cannot("two discriminating search tokens in the cohort")
			: ready({ a, b })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.tokens-and",
	needs: "searchable fields and two tokens that split the cohort",
	subjects: subjectsOf.list,
	async run(ctx, { a, b }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const onlyA = await listAll(ctx, q(ctx, { limit, search: a }))
		const onlyB = await listAll(ctx, q(ctx, { limit, search: b }))
		const both = await listAll(ctx, q(ctx, { limit, search: `${a} ${b}` }))
		if (onlyA.exchange.status >= 400 || onlyB.exchange.status >= 400 || both.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a token search was rejected")
		}
		if (!onlyA.complete || !onlyB.complete || !both.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		if (setA.size === 0 || setB.size === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a token taken from the cohort matched nothing (q="${setA.size === 0 ? a : b}"), so how two combine cannot be judged`,
			)
		}
		const expected = new Set([...setA].filter((id) => setB.has(id)))
		const got = setOf(both.items, ctx.identity)
		if (sameSet(expected, got) || sameSet(got, new Set([...setA, ...setB]))) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"two search tokens are not applied as AND",
			`q="${a} ${b}" returned ${got.size}; the intersection of each token is ${expected.size}.`,
			[onlyA.exchange, onlyB.exchange, both.exchange],
		)
	},
}

const searchCaseInsensitive: Check<{ token: string; flipped: string }> = {
	plan: (ctx) => {
		if (conv(ctx).search === undefined) return cannot()
		let sample: string | undefined
		for (const field of ctx.query?.searchable ?? []) {
			const value = ctx.records
				.map((row) => row[field])
				.find((item): item is string => typeof item === "string" && /[A-Za-z]/.test(item))
			if (value !== undefined) {
				sample = value
				break
			}
		}
		if (sample === undefined) return cannot()
		const token = sample.split(/\s+/).find((part) => /[A-Za-z]/.test(part)) ?? sample
		const flipped = token.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		return ready({ flipped, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.case-insensitive",
	needs: "a searchable string with a letter",
	subjects: subjectsOf.list,
	async run(ctx, { flipped, token }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const original = await listAll(ctx, q(ctx, { limit, search: token }))
		const other = await listAll(ctx, q(ctx, { limit, search: flipped }))
		if (original.exchange.status >= 400 || other.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a case-flipped search was rejected")
		}
		if (!original.complete || !other.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		const a = setOf(original.items, ctx.identity)
		const b = setOf(other.items, ctx.identity)
		if (sameSet(a, b)) return ASSERTED
		if (resolvedCaps(ctx).searchCase === "insensitive") {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"search is not case-insensitive",
				`q=${JSON.stringify(token)} and q=${JSON.stringify(flipped)} selected different sets.`,
				[original.exchange, other.exchange],
			)
		}
		return ctx.findings.unresolved(
			this.id,
			ctx.entityName,
			"case-flipped search selected a different set; declare searchCase: insensitive to treat that as a defect",
		)
	},
}

const searchEmptyQ: Check<{ policy: NonNullable<EffectiveQueryCapabilities["searchEmpty"]> }> = {
	plan: (ctx) => {
		const policy = resolvedCaps(ctx).searchEmpty
		return conv(ctx).search === undefined || policy === undefined ? cannot() : ready({ policy })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.empty-q",
	needs: "`searchEmpty` declared",
	subjects: subjectsOf.list,
	async run(ctx, { policy }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const baseline = await listAll(ctx, q(ctx, { limit }))
		const empty = await listAll(ctx, q(ctx, { limit, search: "" }))
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], empty.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"empty q was not rejected",
				`searchEmpty=reject but q= returned ${empty.exchange.status}.`,
				[empty.exchange],
			)
		}
		if (empty.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty q was rejected")
		}
		if (!baseline.complete || !empty.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (sameSet(setOf(empty.items, ctx.identity), setOf(baseline.items, ctx.identity))) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"empty q did not match the unfiltered set",
			`searchEmpty=${policy} but q= returned ${empty.items.length} of ${baseline.items.length} records.`,
			[baseline.exchange, empty.exchange],
		)
	},
}

const searchModeAccepted: Check = {
	plan: (ctx) =>
		when(
			conv(ctx).searchMode !== undefined &&
				(resolvedCaps(ctx).searchModes?.length ?? 0) > 0 &&
				conv(ctx).search !== undefined,
		),
	id: "search.mode-accepted",
	needs: "declared searchModes and a search-mode parameter",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		for (const mode of resolvedCaps(ctx).searchModes ?? []) {
			const result = await list(ctx, q(ctx, { limit: 5, search: "oat", searchMode: mode }))
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") {
				refusedBy.push(result.exchange)
				rejected.push(`${mode} (${result.exchange.status})`)
			}
			if (answer === "unknown") unknown.push(`${mode} (${result.exchange.status})`)
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED
		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"a declared search mode is rejected",
			`rejected: ${rejected.join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
}

const selectRequestedFieldsPresent: Check<{ requested: string[]; projection: Record<string, string> }> = {
	plan: (ctx) => {
		if (conv(ctx).select === undefined || (ctx.query?.selectable.length ?? 0) === 0) return cannot()
		const requested = [
			ctx.identity,
			...(ctx.query?.selectable.filter((name) => name !== ctx.identity).slice(0, 2) ?? []),
		]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ projection, requested })
	},
	dependsOn: ["select.projection-honoured"],
	id: "select.requested-fields-present",
	needs: "a select parameter and at least one selectable field",
	subjects: subjectsOf.list,
	async run(ctx, { projection, requested }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "select probe was rejected or empty")
		}
		const missing = requested.filter((name) => !Object.hasOwn(result.items[0] as object, name))
		if (missing.length === 0) return ASSERTED
		if (
			missing.length === 1 &&
			missing[0] === ctx.identity &&
			!(ctx.query?.selectable.includes(ctx.identity) ?? false)
		) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "identity was omitted from select and missing from items")
		}
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a requested select field is missing from the projection",
			`select=${requested.join(",")} omitted ${missing.join(", ")}.`,
			[result.exchange],
		)
	},
}

const selectUnknownFieldRejected: Check<{
	policy: NonNullable<NonNullable<EffectiveQueryCapabilities["select"]>["unknown"]>
	requested: string[]
	projection: Record<string, string>
}> = {
	plan: (ctx) => {
		const policy = resolvedCaps(ctx).select?.unknown
		if (conv(ctx).select === undefined || policy === undefined) return cannot()
		const requested = [ctx.identity, "oat_no_such_select_xyz"]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ policy, projection, requested })
	},
	dependsOn: ["select.projection-honoured", "error.malformed-filter-not-5xx"],
	id: "select.unknown-field-rejected",
	needs: "`select.unknown` declared",
	subjects: subjectsOf.list,
	async run(ctx, { policy, projection }): Promise<Outcome> {
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), ...projection })
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown select field was not rejected",
				`select.unknown=reject but the probe returned ${result.exchange.status}.`,
				[result.exchange],
			)
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "unknown select field was rejected under ignore")
		}
		const extras = Object.keys(result.items[0] ?? {}).filter((key) => key === "oat_no_such_select_xyz")
		if (extras.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown select field was honoured under ignore",
			"select.unknown=ignore should drop the undeclared name, not return it.",
			[result.exchange],
		)
	},
}

const selectNestedHonoured: Check<{
	relation: { name: string; fields: string[] }
	first: string
	projection: Record<string, string>
}> = {
	plan: (ctx) => {
		if (conv(ctx).select === undefined || resolvedCaps(ctx).select?.nested !== true) return cannot()
		const relation = resolvedCaps(ctx).select?.relations?.[0]
		const first = relation?.fields[0]
		if (relation === undefined || first === undefined) return cannot()
		const projection = selectTerm(conv(ctx), [ctx.identity, `${relation.name}(${first})`], ctx.entityName)
		return projection === null ? cannot() : ready({ first, projection, relation })
	},
	dependsOn: ["select.projection-honoured"],
	id: "select.nested-honoured",
	needs: "select.nested and a named relation",
	subjects: subjectsOf.list,
	async run(ctx, { first, projection, relation }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "nested select was rejected or empty")
		}
		/* A to-one relation comes back as an object, a to-many one as an array of them, and a
		 * record with no related row as null — which says nothing about the projection. */
		const related: Record_[] = []
		for (const item of result.items) {
			const nested = item[relation.name]
			if (nested === null || nested === undefined) continue
			const rows = Array.isArray(nested) ? nested : [nested]
			const scalar = rows.find((row) => row === null || typeof row !== "object" || Array.isArray(row))
			if (scalar !== undefined) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nested select did not return the relation as records",
					`select=${relation.name}(${first}) left "${relation.name}" holding ${JSON.stringify(scalar)}.`,
					[result.exchange],
				)
			}
			related.push(...(rows as Record_[]))
		}
		if (related.length === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no listed record has a "${relation.name}" to project`)
		}
		const keys = [...new Set(related.flatMap((row) => Object.keys(row)))]
		if (keys.every((key) => key === first)) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"nested select did not restrict the relation to the requested field",
			`select=${relation.name}(${first}) returned ${keys.join(", ") || "(empty)"}.`,
			[result.exchange],
		)
	},
}

const querySortAndSelectCompose: Check<{ field: string; requested: string[]; projection: Record<string, string> }> = {
	plan: (ctx) => {
		if (conv(ctx).order === undefined || conv(ctx).select === undefined || ctx.records.length <= 1) return cannot()
		if ((ctx.query?.selectable.length ?? 0) === 0) return cannot()
		const field = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (field === undefined) return cannot()
		/* The sort field itself must survive the projection, or the order has nothing to be read off. */
		const requested = field === ctx.identity ? [ctx.identity] : [ctx.identity, field]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ field, projection, requested })
	},
	dependsOn: ["sort.order-is-applied", "select.projection-honoured", "select.requested-fields-present"],
	id: "query.sort-and-select-compose",
	needs: "sortable and selectable fields",
	subjects: subjectsOf.list,
	async run(ctx, { field, projection, requested }): Promise<Outcome> {
		const result = await list(ctx, {
			...q(ctx, { limit: 20, order: sortTerm(conv(ctx), field, "asc") }),
			...projection,
		})
		if (result.exchange.status >= 400 || result.items.length < 2) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "sort+select probe was rejected")
		}
		const extras = Object.keys(result.items[0] ?? {}).filter((key) => !requested.includes(key))
		const values = result.items.map((item) => item[field])
		if (extras.length === 0 && sortedUnder(ctx, field, values) !== null) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"sort and select do not compose",
			extras.length > 0
				? `select leaked ${extras.slice(0, 5).join(", ")}.`
				: `order=${field}.asc did not hold under the projection.`,
			[result.exchange],
		)
	},
}

const querySearchAndSelectCompose: Check<{
	field: string
	token: string
	requested: string[]
	projection: Record<string, string>
}> = {
	plan: (ctx) => {
		if (conv(ctx).search === undefined || conv(ctx).select === undefined) return cannot()
		const field = ctx.query?.searchable[0]
		if (field === undefined || (ctx.query?.selectable.length ?? 0) === 0) return cannot()
		const token = ctx.records
			.map((row) => row[field])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return cannot(`a cohort value of "${field}" long enough to search for`)
		const requested = [ctx.identity, field]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ field, projection, requested, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result", "select.projection-honoured"],
	id: "query.search-and-select-compose",
	needs: "searchable and selectable fields",
	subjects: subjectsOf.list,
	async run(ctx, { projection, token }): Promise<Outcome> {
		const searched = await listAll(ctx, q(ctx, { limit: pageSize(ctx), search: token }))
		const combined = await listAll(ctx, { ...q(ctx, { limit: pageSize(ctx), search: token }), ...projection })
		if (searched.exchange.status >= 400 || combined.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+select probe was rejected")
		}
		if (!searched.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (combined.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
		}
		if (sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a select changes which records a search returns",
			`q=${JSON.stringify(token)} alone matched ${searched.items.length}; with select it matched ${combined.items.length}.`,
			[searched.exchange, combined.exchange],
		)
	},
}

const querySearchAndSortCompose: Check<{ searchField: string; sortField: string; token: string }> = {
	plan: (ctx) => {
		if (conv(ctx).search === undefined || conv(ctx).order === undefined) return cannot()
		const searchField = ctx.query?.searchable[0]
		const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (searchField === undefined || sortField === undefined) return cannot()
		const token = ctx.records
			.map((row) => row[searchField])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return cannot(`a cohort value of "${searchField}" long enough to search for`)
		return ready({ searchField, sortField, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result", "sort.order-is-applied"],
	id: "query.search-and-sort-compose",
	needs: "searchable and sortable fields",
	subjects: subjectsOf.list,
	async run(ctx, { sortField, token }): Promise<Outcome> {
		const searched = await listAll(ctx, q(ctx, { limit: pageSize(ctx), search: token }))
		const combined = await listAll(
			ctx,
			q(ctx, { limit: pageSize(ctx), search: token, order: sortTerm(conv(ctx), sortField, "asc") }),
		)
		if (searched.exchange.status >= 400 || combined.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+sort probe was rejected")
		}
		if (!searched.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (!sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"adding a sort changes which records a search returns",
				`q=${JSON.stringify(token)} membership changed when order=${sortField} was added.`,
				[searched.exchange, combined.exchange],
			)
		}
		const values = combined.items.map((item) => item[sortField])
		if (sortedUnder(ctx, sortField, values) !== null) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"search results are not ordered",
			`q + order=${sortField}.asc did not keep ${sortField} ascending.`,
			[combined.exchange],
		)
	},
}

const queryFilterSearchSortSelectCompose: Check<
	Subset & { token: string; sortField: string; requested: string[]; projection: Record<string, string> }
> = {
	plan: (ctx) => {
		const c = conv(ctx)
		if (!filterable(ctx) || c.search === undefined || c.order === undefined || c.select === undefined) return cannot()
		if ((ctx.query?.selectable.length ?? 0) === 0 || ctx.records.length <= 2) return cannot()
		const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (sortField === undefined) return cannot()
		return andThen(overlapPlan(ctx), (overlap) => {
			const extra = ctx.query?.selectable.find((name) => name !== ctx.identity)
			const requested = extra === undefined ? [ctx.identity] : [ctx.identity, extra]
			const projection = selectTerm(c, requested, ctx.entityName)
			return projection === null ? cannot() : ready({ ...overlap, projection, requested, sortField })
		})
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"query.search-and-filter-compose",
		"query.axes-compose",
		"query.filter-and-select-compose",
		"query.sort-and-select-compose",
		"query.filter-sort-select-compose",
		"query.filter-search-sort-compose",
		"query.filter-search-select-compose",
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-search-sort-select-compose",
	needs: "all four list axes declared and at least three records",
	subjects: subjectsOf.list,
	async run(ctx, { projection, sortField, term, token }): Promise<Outcome> {
		const conventions = conv(ctx)
		const base = await collectSet(ctx, pageSize(ctx), {
			...term,
			...(conventions.search === undefined ? {} : { [conventions.search]: token }),
		})
		const combined = await collectSet(
			ctx,
			pageSize(ctx),
			{ ...term, ...projection, ...(conventions.search === undefined ? {} : { [conventions.search]: token }) },
			sortTerm(conventions, sortField, "asc"),
		)
		if (base === null || combined === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "four-axis probe was rejected")
		}
		if (!base.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (combined.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
		}
		if (sameSet(setOf(base.items, ctx.identity), setOf(combined.items, ctx.identity))) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"filter ∩ search membership changes when sort and select join",
			`the four-axis listing returned ${combined.items.length}; filter+search alone returned ${base.items.length}.`,
			[base.last.exchange, combined.last.exchange],
		)
	},
}

/** Item GET when available — list projections can disagree with stored unique values. */
async function liveRecord(ctx: CheckContext, id: string | undefined): Promise<Record_ | undefined> {
	if (id === undefined || ctx.readOp === undefined) return undefined
	try {
		const exchange = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
		if (exchange.status >= 300 || exchange.responseBody === null || typeof exchange.responseBody !== "object") {
			return undefined
		}
		return exchange.responseBody as Record_
	} catch {
		return undefined
	}
}

async function teardownCreatedId(ctx: WriteContext, id: string): Promise<void> {
	const deleteOp = ctx.deleteOp ?? ctx.model.byOperationId.get(ctx.model.entities.get(ctx.entityName)?.delete ?? "")
	if (deleteOp === undefined) return
	try {
		await ctx.client.request("DELETE", fillPath(deleteOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
	} catch {
		/* A leftover row is worse than a teardown 404. */
	}
}

const uniqueConflictCreate: Check<{ createOp: OperationModel; sets: string[][] }> = {
	plan: (ctx) => {
		const createOp = ctx.uniqueCreateOp
		if (createOp === undefined || (ctx.uniqueSets?.length ?? 0) === 0 || ctx.records.length === 0) return cannot()
		const sets = probeableUniqueSets(createOp, ctx.model, "create", ctx.uniqueSets)
		return sets.length === 0 ? cannot() : ready({ createOp, sets })
	},
	/* Reads whole sets across pages, so a walk that skips or repeats records corrupts them. */
	dependsOn: ["pagination.page-walk-covers-set"],
	id: "create.unique-conflict-rejected",
	mutates: true,
	needs: "x-unique on create with at least one probeable column set, and a known row",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, sets }): Promise<Outcome> {
		const schema = requestSchemaOf(ctx, createOp)
		const bodyCols = bodyPropertyNames(createOp, ctx.model)
		const path = fillPath(createOp.path, ctx.scope)
		const required = idempotencyHeaderRequired(createOp, ctx.model)
		const listLimit = pageSize(ctx)
		const before = await listAll(ctx, q(ctx, { limit: listLimit }))
		/* A growth in the collection is only visible when both reads cover all of it. */
		const listResolved = before.exchange.status < 400 && before.complete
		const evidence: Exchange[] = listResolved ? [before.exchange] : []
		const seedId = ctx.records[0] === undefined ? undefined : String(ctx.records[0][ctx.identity])
		const known = (await liveRecord(ctx, seedId)) ?? ctx.records[0]
		if (known === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no known row to collide unique values against")
		}

		for (const [index, set] of sets.entries()) {
			const base = uniquifyProbeBody(
				validBody(ctx, schema ?? {}),
				ctx.uniqueSets,
				schema,
				`u${ctx.nonce}${index}${ctx.client.transcript.length}`,
			)
			const body = collisionCreateBody(base, known, set, ctx.scope, bodyCols, createOp.generated)
			if (body === null) continue
			const headers = uniqueProbeHeaders(
				ctx.auth(),
				createOp.idempotencyHeader,
				required,
				`oat-unique-${ctx.entityName}-${ctx.seed}-${index}`,
			)
			const encoded = await encodeOpBody(ctx, createOp, body)
			const probe = await ctx.client.request("POST", path, { ...encoded, headers, operationId: createOp.operationId })
			evidence.push(probe)
			if (standDownForFeatureGate(ctx, createOp, probe, this.id)) continue
			if (isPlanLimitResponse(probe.status, probe.responseBody)) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${createOp.operationId} did not apply`,
					`${createOp.operationId} returned ${probe.status} (plan limit) on a unique-conflict ` +
						"probe, so uniqueness was not observed.",
				)
				continue
			}
			const after = await listAll(ctx, q(ctx, { limit: listLimit }))
			if (after.exchange.status < 400 && after.complete) evidence.push(after.exchange)
			if (probe.status === 409) {
				if (listResolved && after.exchange.status < 400 && after.complete && after.items.length > before.items.length) {
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						"a unique-conflict 409 still grew the collection",
						`POST colliding ${set.join(", ")} returned 409 but the list grew from ` +
							`${before.items.length} to ${after.items.length}.`,
						[before.exchange, probe, after.exchange],
					)
				}
				continue
			}
			if (probe.status >= 200 && probe.status < 300) {
				const returned = (probe.responseBody ?? {}) as Record_
				const id = returned[ctx.identity]
				if (typeof id === "string" || typeof id === "number") await teardownCreatedId(ctx, String(id))
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a duplicate unique-set create was accepted",
					`${createOp.operationId} returned ${probe.status} for a second create colliding ` +
						`${set.join(", ")}. A documented unique constraint must be 409, not 2xx.`,
					evidence.slice(-3),
				)
				continue
			}
			if (probe.status >= 500) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a duplicate unique-set create drew a server error",
					`${createOp.operationId} returned ${probe.status} for a second create colliding ` +
						`${set.join(", ")}. A documented unique constraint must be refused with 409, not crash.`,
					[probe],
				)
				continue
			}
			ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`unique probe for ${set.join(", ")} returned ${probe.status}, which is not a 409 unique conflict`,
			)
		}
		return ASSERTED
	},
}

const uniqueConflictUpdate: Check<{ updateOp: OperationModel; sets: string[][] }> = {
	plan: (ctx) => {
		const updateOp = ctx.uniqueUpdateOp
		if (updateOp === undefined || (ctx.uniqueSets?.length ?? 0) === 0 || ctx.records.length === 0) return cannot()
		if (ctx.createOp === undefined) return cannot()
		const sets = probeableUniqueSets(updateOp, ctx.model, "update", ctx.uniqueSets)
		return sets.length === 0 ? cannot() : ready({ sets, updateOp })
	},
	/* Reads whole sets across pages, so a walk that skips or repeats records corrupts them. */
	dependsOn: ["pagination.page-walk-covers-set"],
	id: "update.unique-conflict-rejected",
	mutates: true,
	needs: "x-unique, an update operation with a probeable set, a create, and a known row",
	subjects: subjectsOf.update,
	async run(ctx, { sets, updateOp }): Promise<Outcome> {
		const bodyCols = bodyPropertyNames(updateOp, ctx.model)
		const required = idempotencyHeaderRequired(updateOp, ctx.model)
		const listLimit = pageSize(ctx)
		const first = ctx.records[0]
		const source = first === undefined ? undefined : ((await liveRecord(ctx, String(first[ctx.identity]))) ?? first)
		if (source === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no live record holds unique values to collide with")
		}

		for (const [index, set] of sets.entries()) {
			/* The record that is made to collide is one made for the purpose: a cohort record
			 * written onto another's unique values is no longer the record every other check
			 * planned against, and a backend that accepts the write leaves the two indistinct. */
			const made = await scratchRecord(ctx, this.id)
			if ("outcome" in made) return made.outcome
			const target = made.scratch.record
			if (!set.some((col) => JSON.stringify(target[col]) !== JSON.stringify(source[col]))) continue
			/* Read once the record exists, so its own create is not mistaken for growth. A growth
			 * is only visible when both reads cover the whole collection. */
			const before = await listAll(ctx, q(ctx, { limit: listLimit }))
			const listResolved = before.exchange.status < 400 && before.complete
			const patch = collisionUpdatePatch(
				source,
				target,
				set,
				ctx.scope,
				bodyCols,
				updateOp.immutable,
				updateOp.generated,
			)
			if (patch === null) continue
			const id = String(target[ctx.identity])
			const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
			const headers = uniqueProbeHeaders(
				ctx.auth(),
				updateOp.idempotencyHeader,
				required,
				`oat-unique-patch-${ctx.entityName}-${ctx.seed}-${index}`,
			)
			const update = await updateRequest(ctx, updateOp, target, patch)
			const probe = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
				...update.options,
				headers,
				operationId: updateOp.operationId,
			})
			if (standDownForFeatureGate(ctx, updateOp, probe, this.id)) continue
			if (isPlanLimitResponse(probe.status, probe.responseBody)) {
				ctx.findings.gap(
					this.id,
					ctx.entityName,
					`${updateOp.operationId} did not apply`,
					`${updateOp.operationId} returned ${probe.status} (plan limit) on a unique-conflict ` +
						"probe, so uniqueness was not observed.",
				)
				continue
			}
			const after = await listAll(ctx, q(ctx, { limit: listLimit }))
			if (probe.status === 409) {
				if (listResolved && after.exchange.status < 400 && after.complete && after.items.length > before.items.length) {
					ctx.findings.backend(
						this.id,
						ctx.entityName,
						"a unique-conflict 409 still grew the collection",
						`PATCH colliding ${set.join(", ")} returned 409 but the list grew from ` +
							`${before.items.length} to ${after.items.length}.`,
						[before.exchange, probe, after.exchange],
					)
				}
				continue
			}
			if (probe.status >= 200 && probe.status < 300) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a duplicate unique-set update was accepted",
					`${updateOp.operationId} returned ${probe.status} when ${update.method} moved a different row ` +
						`onto ${set.join(", ")} values already held by another row. A documented unique ` +
						"constraint must be 409, not 2xx.",
					[probe],
				)
				continue
			}
			if (probe.status >= 500) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"a duplicate unique-set update drew a server error",
					`${updateOp.operationId} returned ${probe.status} when ${update.method} moved a different row ` +
						`onto ${set.join(", ")} values already held by another row. A documented unique ` +
						"constraint must be refused with 409, not crash.",
					[probe],
				)
				continue
			}
			ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`unique ${update.method} for ${set.join(", ")} returned ${probe.status}, which is not a 409 unique conflict`,
			)
		}
		return ASSERTED
	},
}

export const CHECKS: readonly Check[] = [
	/* foundations — did the write land, is it visible, and do the paging primitives work at all.
	 * Everything below assumes these hold, so they must be evaluated first for cascade
	 * suppression to have anything to consult. */
	readAfterWrite,
	createPersistsFields,
	createStatusMatchesSpec,
	successSchemaHonoured,
	limitBoundsPageSize,
	limitRespectsMax,
	hasMoreIsAccurate,
	/* Ordering and the page walk are foundations too, not query niceties: the set-algebra checks
	 * below gather their sets *across pages*, so a broken walk would corrupt the very sets they
	 * compare. Establishing paging first is what lets those failures be suppressed as cascades
	 * rather than re-reported once per predicate. */
	orderChangesResult,
	pageWalkCoversSet,
	cursorAgreesWithPage,
	/* Where the filter is applied relative to paging: every filtered read below relies on it. */
	filterAndPagingCompose,
	paginationBoundsHandled,
	sortNumericOrderIsNumeric,
	sortStableTiebreak,
	/* These read whole sets in both directions, so they come after the walk they rely on. */
	sortReverseSymmetry,
	sortNullsFirstLast,
	sortMultiKeyTiebreak,
	sortDefaultOrderApplied,

	/* query semantics */
	unknownFilterRejected,
	malformedFilterNot5xx,
	sortUnknownFieldRejected,
	equalityFilterSelectsOne,
	zeroMatchFilter,
	negationPartitions,
	filterAndComposesAsIntersection,
	filterOrComposesAsUnion,
	filterInIsUnionOfEq,
	filterNinComplementsIn,
	filterNestedAndOrDistributes,
	likeEscaping,
	filterIlikeIsCaseInsensitive,
	filterIsNullSelectsNulls,
	filterContainsMembership,
	searchNarrowsResult,
	searchTokensAnd,
	searchCaseInsensitive,
	searchEmptyQ,
	searchModeAccepted,
	selectProjection,
	selectRequestedFieldsPresent,
	selectUnknownFieldRejected,
	unknownParameterConsistent,
	selectNestedHonoured,
	countIsConsistentWithPage,
	countMatchesWalk,
	numericComparisonIsNumeric,
	filterGteIsGtOrEq,
	filterLteIsLtOrEq,
	filterOrderedTriplePartitions,

	/* write semantics */
	uniqueConflictCreate,
	uniqueConflictUpdate,
	patchMinimality,
	immutableRejected,
	stringPayloadSurvives,
	idempotentReplay,
	declaredInvalidationHappens,
	projectionsAgree,
	queryAxesCompose,
	filterAndSelectCompose,
	searchAndFilterCompose,
	filterSortSelectCompose,
	filterSearchSortCompose,
	filterSearchSelectCompose,
	querySortAndSelectCompose,
	querySearchAndSelectCompose,
	querySearchAndSortCompose,
	queryFilterSearchSortSelectCompose,
	declaredFilterableWorks,
	declaredFilterableOpsAccepted,
	declaredSortableWorks,
	declaredSortableNullsAccepted,
	declaredSelectableWorks,
	filterAliasMatchesCanonical,
	filterIllegalOpRejected,
	filterEmptyIn,
	filterInOverLimitRejected,
	filterConditionCapRejected,
	noLostUpdate,
	deleteMissingIs404,
	softDeleteHidden,

	/* input validation */
	enumValidated,
	maxLengthValidated,
	requiredValidated,
	contentTypeEnforced,

	/* isolation */
	crossTenantItemRead,
	crossTenantItemWrite,
	foreignParentRejected,
	denialDoesNotRevealExistence,
	crossTenantFilterBypass,
	rankIsMonotonic,
	rankIsMonotonicOnWrites,
	inviteGrantsThenRevokes,
	selfIdentityCheck,
	publicGetCheck,

	/* declared side effects and async lifecycles, last: both invoke operations that change the
	 * world, and both are meaningless if the read surface above is already known broken */
	declaredEffectsOccur,
	sideEffectArrives,
	asyncReachesTerminalState,
	asyncReceiptIsResolvable,
	/* After every other check has written to the transcript — create is owned by
	 * create.status-matches-document. */
	documentedStatusHonoured,
	errorSchemaHonoured,
	declaredRateLimitHonoured,
]

/** Plans a check and, when it applies, runs it — what the scheduler does, for one check. */
export async function runCheck(check: Check, ctx: WriteContext): Promise<Outcome> {
	const planned = check.plan(ctx)
	if (!planned.ok) return standDown(planned.needs ?? check.needs ?? "an unstated precondition")
	return check.run(ctx, planned.value)
}

/**
 * The registry checks itself as it loads: ids are unique, every id is one `CheckId` names, and
 * every dependency is registered earlier. A dependency registered later can never suppress
 * anything — it has not run yet when the scheduler consults it.
 */
export function validateRegistry(checks: readonly Check[]): void {
	const position = new Map<string, number>()
	for (const [index, check] of checks.entries()) {
		if (position.has(check.id)) throw new Error(`check "${check.id}" is registered twice`)
		position.set(check.id, index)
	}
	for (const id of CHECK_IDS) {
		if (!position.has(id)) throw new Error(`check "${id}" is named in CHECK_IDS but never registered`)
	}
	for (const [index, check] of checks.entries()) {
		for (const dependency of check.dependsOn ?? []) {
			const at = position.get(dependency)
			if (at === undefined) throw new Error(`check "${check.id}" depends on "${dependency}", which is not registered`)
			if (at >= index) {
				throw new Error(`check "${check.id}" depends on "${dependency}", which is registered after it`)
			}
		}
	}
}

validateRegistry(CHECKS)
