/**
 * Seeds the world once per run: resolves path parameters top-down, then creates a discriminating
 * cohort per entity.
 *
 * Prior art resolved fixtures per test case, which meant one unseedable resource produced dozens
 * of unrelated failures. Here a resolution failure is recorded once and everything downstream is
 * reported as BLOCKED against that single cause.
 */

import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { requestContent } from "../spec/collection.ts"
import { largestPageQuery, owningEntityOf } from "../spec/graph.ts"
import { encodeForOperation } from "./body.ts"
import { forEachInvocation } from "./upload-each.ts"
import type { Client, Exchange, RequestOptions } from "./client.ts"
import { type CohortMember, buildCohort, ensureDistinctUniqueValues, isOverflowError, overflowFrom } from "./fixture.ts"
import { isUniqueConflictResponse, uniqueTupleCollides, uniquifyProbeBody } from "./unique.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "./feature-gate.ts"
import type { UploadContext } from "./upload.ts"
import { type ProvenId, returnedId } from "./proven-id.ts"
import { createdRecordOf, resolveCreatedId } from "./created-id.ts"
import { FencedError } from "./fence.ts"
import { readPath } from "./path.ts"

export type Record_ = Record<string, unknown>

function isScalarId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number"
}

function isPlainRecord(value: unknown): value is Record_ {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export { createdRecordOf } from "./created-id.ts"

/**
 * The record a create made, carrying an id oat may delete by, or `null` when none can be read.
 *
 * An id the answer names by contract (a declared `createdIdFrom`, or its own identity) stands. A
 * candidate — the record under an envelope, an id key found deeper in the answer — stands once a
 * read under it shows what was sent; so does an id the client chose, for a create that answers
 * only an acknowledgement. `acknowledged` says the answer named no id at all.
 */
export async function createdRecord(input: {
	client: Pick<Client, "get">
	model: SpecModel
	createOp: OperationModel
	exchange: Exchange
	sent: unknown
	scope: Record<string, string>
	headers: RequestOptions["headers"]
	readable?: (op: OperationModel) => boolean
}): Promise<{ record: Record_; acknowledged: boolean } | null> {
	const { createOp, model } = input
	const entity = createOp.entity
	const identity = (entity === null ? undefined : model.entities.get(entity))?.identity ?? "id"
	const body = input.exchange.responseBody ?? {}
	/* A probe may send the body as JSON text under another media type: compare what it said. */
	const sent = jsonText(input.sent)
	/* A declared record path wins; without one, the envelope is inferred from what was sent. */
	const record = createOp.recordPath === null ? createdRecordOf(body, identity, sent) : (recordOf(createOp, body) ?? {})
	const resolved = resolveCreatedId({
		body,
		entity: entity ?? "",
		identity,
		sent,
		source: { createdIdFrom: createOp.createdIdFrom, recordPath: createOp.recordPath },
	})
	if (resolved?.trusted === true) return { acknowledged: false, record: { ...record, [identity]: resolved.value } }
	if (entity === null) return null
	const confirmed = await confirmSubmitted({
		client: input.client,
		entity,
		headers: input.headers,
		identity,
		model,
		scope: input.scope,
		sent,
		...(resolved === undefined ? {} : { id: resolved.id }),
		...(input.readable === undefined ? {} : { readable: input.readable }),
	})
	return confirmed === null ? null : { acknowledged: resolved === undefined, record: confirmed }
}

/**
 * The record a single-record answer holds: the object at the operation's declared
 * `x-entity.recordPath`, or the body itself when nothing is declared. `undefined` when there is
 * none — an update that answers `{ success, id, message }` holds no record, and comparing against
 * an empty one would report every field dropped.
 */
export function recordOf(op: { recordPath: string | null }, body: unknown): Record_ | undefined {
	const record = op.recordPath === null ? body : readPath(body, op.recordPath)
	return isPlainRecord(record) ? record : undefined
}

/**
 * A record's identity as text, or `undefined` when it has none to give. Every id oat puts in a
 * request goes through here (lint rule `oat/id-through-reader`): `String(record[identity])` on a
 * record without one is the text "undefined", and a request made from it means nothing.
 */
export function idOf(record: Record_ | undefined, identity: string): string | undefined {
	const value = record?.[identity]
	return isScalarId(value) ? String(value) : undefined
}

function jsonText(sent: unknown): unknown {
	if (typeof sent !== "string") return sent
	try {
		return JSON.parse(sent) as unknown
	} catch {
		return sent
	}
}

export interface Scope {
	values: Record<string, string>
	/** Records created while resolving ancestors, newest last — unwound in reverse at teardown. */
	created: Array<{ entity: string; path: string; id: string }>
}

export class SeedError extends Error {
	constructor(
		readonly cause_: string,
		message: string,
		/** Status the failing request returned, when the failure was an HTTP response. */
		readonly status?: number,
		/** The create that failed, when the failure was one — a parent's, not always the entity's own. */
		readonly operationId?: string,
		readonly exchange?: Exchange,
	) {
		super(message)
	}
}

/**
 * Reads back a record an acknowledgement-only create made under a client-chosen identity.
 *
 * An id oat only sent proves nothing: a server may ignore it and store the record under one of its
 * own, and on an integer-id API the id oat sent can belong to somebody else's row. The submitted
 * id counts only when the entity's read, under that id, answers with that id and with every scalar
 * field oat sent (`ignore` names fields the caller expects to differ). Anything less — no read, a
 * read oat may not call, a refusal, another record — is `null`, and the record stays untracked.
 */
export async function confirmSubmitted(input: {
	client: Pick<Client, "get">
	model: SpecModel
	entity: string
	identity: string
	sent: unknown
	/** The id to read under, when the answer suggested one; otherwise the identity oat sent. */
	id?: string
	scope: Record<string, string>
	headers: RequestOptions["headers"]
	ignore?: readonly string[]
	readable?: (op: OperationModel) => boolean
}): Promise<Record_ | null> {
	const { identity, sent } = input
	if (!isPlainRecord(sent)) return null
	const id = input.id ?? (isScalarId(sent[identity]) ? String(sent[identity]) : undefined)
	if (id === undefined) return null
	const ignored = new Set([identity, ...(input.ignore ?? [])])
	const fields = Object.entries(sent).filter(
		([key, value]) =>
			!ignored.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
	)
	if (fields.length === 0) return null
	const readId = input.model.entities.get(input.entity)?.read
	const readOp = readId === undefined ? undefined : input.model.byOperationId.get(readId)
	const param = readOp?.pathParams.at(-1)
	if (readOp === undefined || param === undefined || input.readable?.(readOp) === false) return null
	let path: string
	try {
		path = fillPath(readOp.path, { ...input.scope, [param]: id })
	} catch {
		return null
	}
	const read = await input.client.get(path, {
		...(input.headers === undefined ? {} : { headers: input.headers }),
		operationId: readOp.operationId,
	})
	const record = read.status < 200 || read.status >= 300 ? undefined : recordOf(readOp, read.responseBody)
	if (record === undefined) return null
	if (!isScalarId(record[identity]) || String(record[identity]) !== id) return null
	return fields.every(([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value)) ? record : null
}

export function fillPath(template: string, values: Record<string, string>): string {
	return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
		const value = values[name]
		if (value === undefined) throw new SeedError(name, `no value for path parameter {${name}}`)
		return encodeURIComponent(value)
	})
}

/**
 * A plan-limit refusal — 402, or a 4xx whose body names payment_required / *_plan_limit.
 *
 * Not a fixture defect: the tenant already has the thing (extract created a table, the free
 * plan is full). Callers reuse an existing same-tenant row instead of inventing one.
 */
export function isPlanLimitResponse(status: number, body: unknown): boolean {
	if (status === 402) return true
	if (status < 400 || status >= 500 || status === 429) return false
	return planLimitSignal(body) !== null
}

function planLimitSignal(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null
	const rec = body as Record<string, unknown>
	const candidates: unknown[] = [rec.error, rec.error_key, rec.code, rec.type, rec.reason, rec.status_key]
	const vars = rec.vars
	if (vars !== null && typeof vars === "object") {
		const inner = vars as Record<string, unknown>
		candidates.push(inner.type, inner.code, inner.error, inner.error_key)
	}
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue
		const normalised = candidate.toLowerCase()
		if (normalised === "payment_required" || normalised === "plan_limit" || normalised.includes("plan_limit")) {
			return normalised
		}
	}
	return null
}

/** Pulls the collection out of a list body the same way seed fallback and effect checks do. */
export function recordsFromList(body: unknown, collectionKey: string | null): Record_[] {
	if (Array.isArray(body)) return body as Record_[]
	if (body !== null && typeof body === "object" && collectionKey !== null) {
		const items = (body as Record<string, unknown>)[collectionKey]
		return Array.isArray(items) ? (items as Record_[]) : []
	}
	return []
}

/** Same-tenant records the list route already returns. Empty when the route cannot be resolved. */
export async function listExisting(
	listOp: OperationModel,
	model: SpecModel,
	client: Client,
	headers: Record<string, string> | (() => Record<string, string>),
	values: Record<string, string>,
): Promise<Record_[]> {
	for (const param of listOp.pathParams) {
		if (values[param] === undefined) return []
	}
	try {
		const exchange = await client.get(fillPath(listOp.path, values), {
			headers,
			operationId: listOp.operationId,
			query: largestPageQuery(model, listOp),
		})
		if (exchange.status >= 300) return []
		return recordsFromList(exchange.responseBody, listOp.collection?.key ?? null)
	} catch (error) {
		/* A fenced read is not an empty collection. */
		if (error instanceof FencedError) throw error
		return []
	}
}

export interface WorldOptions {
	roots: Record<string, string>
	seed: number
	/**
	 * Per-run token mixed into every value that must not collide with an earlier run's records —
	 * unique columns, above all. A seed alone repeats exactly, which is its job.
	 */
	nonce?: string
	cohortSize?: number
	authHeaders: () => Record<string, string>
	uploads?: UploadContext
	/**
	 * Called the moment a record exists, before anything else can fail. A record learned about
	 * only after the step that made it returns is dropped whenever a later step throws.
	 */
	onCreate?: (entity: string, id: ProvenId, scope: Record<string, string>) => void
	/** Called for a create that answered 2xx with no id oat could read: the record may remain. */
	onUnidentified?: (entity: string, operationId: string, exchange: Exchange) => void
	/** Whether oat may call an operation (a profile can exclude one); omitted means every one. */
	readable?: (op: OperationModel) => boolean
	/** Who is creating — keys the ancestor cache, since one principal's parent is not another's. */
	principal?: string
	/** Ancestors already made in this run, by principal, operation and parent path. */
	ancestors?: Map<string, string>
}

/**
 * Resolves every path parameter an operation needs. Roots come from config; everything else is
 * created through the owning entity's create operation, depth-first.
 */
export async function resolvePathScope(
	op: OperationModel,
	model: SpecModel,
	client: Client,
	options: WorldOptions,
	scope: Scope = { created: [], values: {} },
): Promise<Scope> {
	for (const param of op.pathParams) {
		if (scope.values[param] !== undefined) continue

		const fromRoot = options.roots[param]
		if (fromRoot !== undefined) {
			scope.values[param] = fromRoot
			continue
		}

		const owner = owningEntityOf(model.operations, op.path, param)
		if (owner === null) {
			throw new SeedError(param, `path parameter {${param}} names no entity oat can create`)
		}
		const entity = model.entities.get(owner)
		if (entity?.create === undefined) {
			throw new SeedError(
				param,
				`{${param}} identifies a "${owner}", which has no create operation — supply it as a root`,
			)
		}
		const createOp = model.byOperationId.get(entity.create)
		if (createOp === undefined) throw new SeedError(param, `missing operation ${entity.create}`)
		/* A create whose own path names the record it makes (`PUT /things/{thing_id}`): resolving
		 * the parameter through it would resolve the same create again, without end. */
		if (createOp.pathParams.includes(param)) {
			throw new SeedError(
				param,
				`{${param}} names the "${owner}" ${createOp.operationId} makes, so oat cannot seed it; ` +
					"supply it as a root or create it in a scenario",
			)
		}

		await resolvePathScope(createOp, model, client, options, scope)
		/* One ancestor per principal and parent path: a row and its siblings share the table oat
		 * made for the first of them, instead of each leaving another table behind. */
		const cacheKey = `${options.principal ?? ""}\u0000${createOp.operationId}\u0000${fillPath(createOp.path, scope.values)}`
		const cached = options.ancestors?.get(cacheKey)
		if (cached !== undefined) {
			scope.values[param] = cached
			continue
		}
		/* Entities in parallel lanes can reach the same missing ancestor at once; the second
		 * waits for the first's create rather than making a twin. */
		const pending = options.ancestors === undefined ? undefined : inflightAncestors(options.ancestors).get(cacheKey)
		if (pending !== undefined) {
			scope.values[param] = await pending
			continue
		}
		const creating = (async (): Promise<string> => {
			const { record: created, adopted } = await createOne(createOp, model, client, options, scope)
			const identity = entity.identity ?? "id"
			const id = returnedId(created, identity)
			if (id === undefined) {
				throw new SeedError(param, `create for "${owner}" returned no usable "${identity}"`)
			}
			/* Adopted, not created: somebody else's record, never oat's to remove. */
			if (!adopted) options.onCreate?.(owner, id, { ...scope.values })
			options.ancestors?.set(cacheKey, id)
			return id
		})()
		if (options.ancestors !== undefined) inflightAncestors(options.ancestors).set(cacheKey, creating)
		try {
			scope.values[param] = await creating
		} finally {
			if (options.ancestors !== undefined) inflightAncestors(options.ancestors).delete(cacheKey)
		}
		scope.created.push({
			entity: owner,
			id: scope.values[param] as string,
			path: fillPath(createOp.path, scope.values),
		})
	}
	return scope
}

/** Top-level properties of a request schema that hold text. */
export function stringProperties(schema: Record<string, unknown> | null): string[] {
	const properties = (schema?.properties ?? {}) as Record<string, unknown>
	return Object.entries(properties)
		.filter(([, property]) => {
			const type = isPlainRecord(property) ? property.type : undefined
			return type === "string" || (Array.isArray(type) && type.includes("string"))
		})
		.map(([name]) => name)
}

/** Ancestor creates under way, per ancestor cache. */
const INFLIGHT = new WeakMap<Map<string, string>, Map<string, Promise<string>>>()

function inflightAncestors(cache: Map<string, string>): Map<string, Promise<string>> {
	let pending = INFLIGHT.get(cache)
	if (pending === undefined) {
		pending = new Map()
		INFLIGHT.set(cache, pending)
	}
	return pending
}

async function createOne(
	createOp: OperationModel,
	model: SpecModel,
	client: Client,
	options: WorldOptions,
	scope: Scope,
): Promise<{ record: Record_; adopted: boolean }> {
	const schema = requestSchemaOf(createOp, model)
	let member: CohortMember | undefined
	try {
		;[member] = buildCohort(schema ?? {}, options.seed, ["baseline"], createOp.operationId, {
			defs: model.defs,
			/* A parent made as scaffolding carries the nonce in every string, not only the unique ones:
			 * a server that derives an undeclared key from a name (a slug) must never see the name the
			 * entity's own cohort, another tenant's parent, existing data or a later run takes. */
			distinct: new Set([...(createOp.unique ?? []).flat(), ...stringProperties(schema)]),
			...(options.nonce === undefined ? {} : { nonce: options.nonce }),
		})
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	let body = member?.body ?? {}
	if ((createOp.unique?.length ?? 0) > 0) {
		/* Ancestor creates share the entity seed with the entity's own cohort; unique columns
		 * must not collide with a later seed of the same collection. */
		body = uniquifyProbeBody(body, createOp.unique ?? [], schema, `anc${options.seed}-${options.nonce ?? ""}`)
	}
	const encoded = await encodeForOperation(
		createOp,
		model,
		body,
		uploadContext(options),
		member?.variant ?? "baseline",
		0,
	)
	const exchange = await client.request("POST", fillPath(createOp.path, scope.values), {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		headers: options.authHeaders,
		operationId: createOp.operationId,
	})
	if (exchange.status >= 300) {
		/* Plan limit after an effect (or a sibling create) already filled the quota: reuse a
		 * same-tenant row from the list. Do not invent an id. */
		if (isPlanLimitResponse(exchange.status, exchange.responseBody)) {
			const reused = await adoptExisting(createOp, model, client, options, scope)
			if (reused !== null) return { adopted: true, record: reused }
		}
		if (isUniqueConflictResponse(createOp, exchange.status)) {
			const reused = await adoptExisting(createOp, model, client, options, scope)
			if (reused !== null) return { adopted: true, record: reused }
		}
		throw new SeedError(
			createOp.operationId,
			`${createOp.operationId} returned ${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 300)}`,
			exchange.status,
			createOp.operationId,
			exchange,
		)
	}
	const made = await createdRecord({
		client,
		createOp,
		exchange,
		headers: options.authHeaders,
		model,
		scope: { ...options.roots, ...scope.values },
		sent: body,
		...(options.readable === undefined ? {} : { readable: options.readable }),
	})
	if (made !== null) return { adopted: false, record: made.record }
	/* Made, but by no id oat can read: the caller cannot use it, and teardown cannot remove it. */
	options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
	return { adopted: false, record: {} }
}

/** First listed record with a usable identity, or null — never synthesises a row. */
async function adoptExisting(
	createOp: OperationModel,
	model: SpecModel,
	client: Client,
	options: WorldOptions,
	scope: Scope,
): Promise<Record_ | null> {
	const name = createOp.entity
	if (name === null) return null
	const entity = model.entities.get(name)
	if (entity?.list === undefined) return null
	const listOp = model.byOperationId.get(entity.list)
	if (listOp === undefined) return null
	const records = await listExisting(listOp, model, client, options.authHeaders, { ...options.roots, ...scope.values })
	const identity = entity.identity ?? "id"
	return (
		records.find((record) => {
			const id = record[identity]
			return typeof id === "string" || typeof id === "number"
		}) ?? null
	)
}

export function requestSchemaOf(op: OperationModel, model: SpecModel): Record<string, unknown> | null {
	const raw = model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	return picked === null ? null : picked.schema
}

export interface SeededCohort {
	members: CohortMember[]
	records: Record_[]
	/** Identities the collection held before seeding, as listed: no later create may reuse one. */
	existingIds?: string[]
	/**
	 * Set when the first (or only) create was a documented feature-gate 403.
	 *
	 * Not an error: the document said this principal cannot create the row. The run degrades
	 * the same way a profile-excluded create does.
	 */
	featureGate: { key: string; detail: string; exchange: Exchange } | null
	/**
	 * Create hit a documented plan limit and these records were adopted from the list / an
	 * earlier effect. Write-path checks must stand down — oat did not submit these bodies.
	 */
	adopted?: boolean
	/**
	 * First-variant create returned 409 on an `x-unique` operation and a same-tenant row was
	 * adopted. Unique-conflict checks still run; write-path oracles that need oat's submitted
	 * seed body stay skipped.
	 */
	uniqueAdopted?: boolean
	/**
	 * The create answered an acknowledgement without the record, and the records are the bodies
	 * oat submitted (client-chosen identity). Checks that judge the create's echo stand down.
	 */
	acknowledged?: boolean
	/** Set when extra cohort variants were dropped because unique values could not differ. */
	uniqueGap?: string
	/**
	 * Variants after the first whose create failed. The cohort carries on without them, and the
	 * run reports each: a 5xx is the backend's failure, a 4xx a variant the document permits and
	 * the backend refused.
	 */
	failedVariants?: Array<{ variant: string; exchange: Exchange }>
}

/** Creates the cohort and returns the server's view of each instance. */
export async function seedCohort(
	createOp: OperationModel,
	model: SpecModel,
	client: Client,
	options: WorldOptions,
	scope: Scope,
): Promise<SeededCohort> {
	const schema = requestSchemaOf(createOp, model)
	if (schema === null) {
		throw new SeedError(createOp.operationId, `${createOp.operationId} declares no request body`)
	}
	let members: CohortMember[]
	let uniqueGap: string | undefined
	let existingIds: string[] = []
	/* A client-chosen identity names one record by definition: never generate one an existing record
	 * holds. Generation only — the identity does not join the unique sets checks grade. */
	const ownIdentity = (createOp.entity === null ? undefined : model.entities.get(createOp.entity))?.identity ?? null
	const bodyProperties = (schema.properties ?? {}) as Record<string, unknown>
	const identityInBody =
		ownIdentity !== null &&
		Object.hasOwn(bodyProperties, ownIdentity) &&
		!(createOp.unique ?? []).some((set) => set.length === 1 && set[0] === ownIdentity)
	const avoid: string[][] =
		identityInBody && ownIdentity !== null ? [...(createOp.unique ?? []), [ownIdentity]] : (createOp.unique ?? [])
	try {
		const generated = buildCohort(schema, options.seed, undefined, createOp.operationId, {
			defs: model.defs,
			distinct: new Set(avoid.flat()),
			...(options.nonce === undefined ? {} : { nonce: options.nonce }),
		}).slice(0, options.cohortSize ?? 7)
		const distinct = ensureDistinctUniqueValues(generated, createOp.unique ?? [], schema, {
			defs: model.defs,
			distinct: new Set((createOp.unique ?? []).flat()),
			...(options.nonce === undefined ? {} : { nonce: options.nonce }),
		})
		members = distinct.members
		if (distinct.gap !== null) uniqueGap = distinct.gap
		const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
		const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
		const existing =
			listOp === undefined
				? []
				: await listExisting(listOp, model, client, options.authHeaders, { ...options.roots, ...scope.values })
		if (ownIdentity !== null) {
			existingIds = existing
				.map((row) => row[ownIdentity])
				.filter(isScalarId)
				.map(String)
		}
		if (existing.length > 0 && avoid.length > 0) {
			members = members.map((member, index) => {
				let body = member.body
				for (let token = 0; token < 8 && uniqueTupleCollides(body, avoid, existing); token++) {
					body = uniquifyProbeBody(body, avoid, schema, `ex${index}${token}-${options.nonce ?? ""}`)
				}
				return { ...member, body }
			})
			/* A body still naming an existing record's identity would overwrite or adopt it: never send it. */
			if (identityInBody && ownIdentity !== null) {
				members = members.filter((member) => !uniqueTupleCollides(member.body, [[ownIdentity]], existing))
				if (members.length === 0) {
					throw new SeedError(
						createOp.operationId,
						`every generated "${ownIdentity}" names an existing record, so nothing was created`,
					)
				}
			}
		}
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	const records: Record_[] = []
	const path = fillPath(createOp.path, scope.values)
	const uploads = uploadContext(options)
	const seededMembers: CohortMember[] = []
	const identity = (createOp.entity === null ? undefined : model.entities.get(createOp.entity))?.identity ?? "id"
	let acknowledged = false
	/* `null` for an acknowledgement oat could not confirm: it names no record, so it joins no cohort. */
	const created = async (exchange: Exchange, sent: unknown): Promise<Record_ | null> => {
		/* A create's id is the one its answer names, or one a read under it confirms. A record
		 * with neither is not oat's to track or remove: it joins no cohort and is reported. */
		const made = await createdRecord({
			client,
			createOp,
			exchange,
			headers: options.authHeaders,
			model,
			scope: { ...options.roots, ...scope.values },
			sent,
			...(options.readable === undefined ? {} : { readable: options.readable }),
		})
		if (made === null) {
			options.onUnidentified?.(createOp.entity ?? createOp.operationId, createOp.operationId, exchange)
			return null
		}
		if (made.acknowledged) acknowledged = true
		const id = returnedId(made.record, identity)
		if (createOp.entity !== null && id !== undefined) options.onCreate?.(createOp.entity, id, { ...scope.values })
		return made.record
	}

	const postMember = async (member: CohortMember, nextUploads: typeof uploads): Promise<Exchange> => {
		const encoded = await encodeForOperation(createOp, model, member.body, nextUploads, member.variant, records.length)
		return client.request("POST", path, {
			body: encoded.body,
			...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
			headers: options.authHeaders,
			operationId: createOp.operationId,
			...(nextUploads.fixture === undefined ? {} : { fixture: nextUploads.fixture.filename }),
		})
	}

	const failedVariants: Array<{ variant: string; exchange: Exchange }> = []
	const withGap = (cohort: SeededCohort): SeededCohort => ({
		...cohort,
		...(uniqueGap === undefined ? {} : { uniqueGap }),
		...(failedVariants.length === 0 ? {} : { failedVariants }),
		...(acknowledged ? { acknowledged } : {}),
		...(existingIds.length === 0 ? {} : { existingIds }),
	})

	const failOrAdopt = async (member: CohortMember, exchange: Exchange): Promise<SeededCohort | null> => {
		if (records.length > 0) return withGap({ featureGate: null, members: seededMembers, records })
		if (isDocumentedFeatureGateDenial(createOp, exchange.status, exchange.responseBody)) {
			return withGap({
				featureGate: {
					detail: describeFeatureGate(createOp, exchange.responseBody),
					exchange,
					key: createOp.featureGate as string,
				},
				members: seededMembers,
				records,
			})
		}
		if (isUniqueConflictResponse(createOp, exchange.status)) {
			const adopted = await adoptExisting(createOp, model, client, options, scope)
			if (adopted !== null) {
				return withGap({
					featureGate: null,
					members: seededMembers,
					records: [adopted],
					uniqueAdopted: true,
				})
			}
			throw new SeedError(
				createOp.operationId,
				`seeding "${member.variant}" returned ${exchange.status}: ` +
					JSON.stringify(exchange.responseBody).slice(0, 300),
				exchange.status,
				createOp.operationId,
				exchange,
			)
		}
		if (isPlanLimitResponse(exchange.status, exchange.responseBody)) {
			const adopted = await adoptExisting(createOp, model, client, options, scope)
			if (adopted !== null)
				return withGap({ adopted: true, featureGate: null, members: seededMembers, records: [adopted] })
		}
		throw new SeedError(
			createOp.operationId,
			`seeding "${member.variant}" returned ${exchange.status}: ` + JSON.stringify(exchange.responseBody).slice(0, 300),
			exchange.status,
			createOp.operationId,
			exchange,
		)
	}

	let lastFail: { member: CohortMember; exchange: Exchange } | undefined
	const outcomes = await forEachInvocation(createOp.operationId, uploads, async (nextUploads, slot) => {
		if (slot !== undefined) {
			const [baseline] = members
			const member = baseline ?? { body: {}, variant: "baseline" as const }
			const exchange = await postMember(member, nextUploads)
			if (exchange.status >= 300) {
				lastFail = { exchange, member }
				return null
			}
			const record = await created(exchange, member.body)
			if (record === null) return null
			seededMembers.push(member)
			records.push(record)
			return null
		}
		for (const member of members) {
			const exchange = await postMember(member, nextUploads)
			if (exchange.status >= 300) {
				/* The first create decides whether there is a cohort at all; a later one failing
				 * is a variant lost, reported rather than ending the cohort in silence. */
				if (records.length === 0) return failOrAdopt(member, exchange)
				failedVariants.push({ exchange, variant: member.variant })
				continue
			}
			const record = await created(exchange, member.body)
			/* Acknowledged but never confirmed: no record to stand for, so no member either. */
			if (record === null) continue
			seededMembers.push(member)
			records.push(record)
		}
		return null
	})
	const early = outcomes.find((outcome) => outcome !== null)
	if (early !== undefined) return early
	if (records.length === 0 && lastFail !== undefined) {
		const failed = await failOrAdopt(lastFail.member, lastFail.exchange)
		if (failed !== null) return failed
	}
	return withGap({ featureGate: null, members: seededMembers.length > 0 ? seededMembers : members, records })
}

/**
 * Walk each create schema the way seed will. A cycle that still overflows is a named gap on
 * that operation — plan and doctor must not throw `RangeError` either.
 */
export function probeCreateFixtures(model: SpecModel): void {
	for (const entity of model.entities.values()) {
		if (entity.create === undefined) continue
		const op = model.byOperationId.get(entity.create)
		if (op === undefined) continue
		const schema = requestSchemaOf(op, model) ?? {}
		try {
			buildCohort(schema, 1, ["baseline"], op.operationId, { defs: model.defs })
		} catch (error) {
			if (isOverflowError(error)) {
				const overflow = overflowFrom(error, op.operationId)
				model.gaps.record(op.operationId, "fixture", overflow.message)
			}
		}
	}
}

function uploadContext(options: WorldOptions): UploadContext {
	return (
		options.uploads ?? {
			seed: options.seed,
		}
	)
}
