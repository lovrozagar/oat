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
import { owningEntityName } from "../spec/graph.ts"
import { encodeForOperation } from "./body.ts"
import { forEachInvocation } from "./upload-each.ts"
import type { Client, Exchange } from "./client.ts"
import { type CohortMember, buildCohort, ensureDistinctUniqueValues, isOverflowError, overflowFrom } from "./fixture.ts"
import { isUniqueConflictResponse, uniqueTupleCollides, uniquifyProbeBody } from "./unique.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "./feature-gate.ts"
import type { UploadContext } from "./upload.ts"

export type Record_ = Record<string, unknown>

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
	) {
		super(message)
	}
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
	client: Client,
	headers: Record<string, string> | (() => Record<string, string>),
	values: Record<string, string>,
): Promise<Record_[]> {
	for (const param of listOp.pathParams) {
		if (values[param] === undefined) return []
	}
	try {
		const exchange = await client.get(fillPath(listOp.path, values), { headers, query: { limit: 50 } })
		if (exchange.status >= 300) return []
		return recordsFromList(exchange.responseBody, listOp.collection?.key ?? null)
	} catch {
		return []
	}
}

export interface WorldOptions {
	roots: Record<string, string>
	seed: number
	cohortSize?: number
	authHeaders: () => Record<string, string>
	uploads?: UploadContext
}

/**
 * Resolves every path parameter an operation needs. Roots come from config; everything else is
 * created through the owning entity's create operation, depth-first.
 */
export async function resolveScope(
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

		const owner = owningEntityName(op.path, param)
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

		await resolveScope(createOp, model, client, options, scope)
		const created = await createOne(createOp, model, client, options, scope)
		const identity = entity.identity ?? "id"
		const id = created[identity]
		if (typeof id !== "string" && typeof id !== "number") {
			throw new SeedError(param, `create for "${owner}" returned no usable "${identity}"`)
		}
		scope.values[param] = String(id)
		scope.created.push({
			entity: owner,
			id: String(id),
			path: fillPath(createOp.path, scope.values),
		})
	}
	return scope
}

async function createOne(
	createOp: OperationModel,
	model: SpecModel,
	client: Client,
	options: WorldOptions,
	scope: Scope,
): Promise<Record_> {
	const schema = requestSchemaOf(createOp, model)
	let member: CohortMember | undefined
	try {
		;[member] = buildCohort(schema ?? {}, options.seed, ["baseline"], createOp.operationId)
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	let body = member?.body ?? {}
	if ((createOp.unique?.length ?? 0) > 0) {
		/* Ancestor creates share the entity seed with the entity's own cohort; unique columns
		 * must not collide with a later seed of the same collection. */
		body = uniquifyProbeBody(body, createOp.unique ?? [], schema, `anc${options.seed}`)
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
			if (reused !== null) return reused
		}
		if (isUniqueConflictResponse(createOp, exchange.status)) {
			const reused = await adoptExisting(createOp, model, client, options, scope)
			if (reused !== null) return reused
		}
		throw new SeedError(
			createOp.operationId,
			`${createOp.operationId} returned ${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 300)}`,
			exchange.status,
		)
	}
	return (exchange.responseBody ?? {}) as Record_
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
	const records = await listExisting(listOp, client, options.authHeaders, { ...options.roots, ...scope.values })
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
	/** Set when extra cohort variants were dropped because unique values could not differ. */
	uniqueGap?: string
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
	try {
		const generated = buildCohort(schema, options.seed, undefined, createOp.operationId).slice(
			0,
			options.cohortSize ?? 7,
		)
		const distinct = ensureDistinctUniqueValues(generated, createOp.unique ?? [], schema)
		members = distinct.members
		if (distinct.gap !== null) uniqueGap = distinct.gap
		const entity = createOp.entity === null ? undefined : model.entities.get(createOp.entity)
		const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
		const existing =
			listOp === undefined
				? []
				: await listExisting(listOp, client, options.authHeaders, { ...options.roots, ...scope.values })
		if (existing.length > 0 && (createOp.unique?.length ?? 0) > 0) {
			members = members.map((member, index) => {
				let body = member.body
				for (let token = 0; token < 8 && uniqueTupleCollides(body, createOp.unique ?? [], existing); token++) {
					body = uniquifyProbeBody(body, createOp.unique ?? [], schema, `ex${index}${token}`)
				}
				return { ...member, body }
			})
		}
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	const records: Record_[] = []
	const path = fillPath(createOp.path, scope.values)
	const uploads = uploadContext(options)
	const seededMembers: CohortMember[] = []

	const postMember = async (member: CohortMember, nextUploads: typeof uploads): Promise<Exchange> => {
		const encoded = await encodeForOperation(createOp, model, member.body, nextUploads, member.variant, records.length)
		return client.request("POST", path, {
			body: encoded.body,
			...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
			headers: options.authHeaders,
			operationId: createOp.operationId,
		})
	}

	const withGap = (cohort: SeededCohort): SeededCohort => (uniqueGap === undefined ? cohort : { ...cohort, uniqueGap })

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
			seededMembers.push(member)
			records.push((exchange.responseBody ?? {}) as Record_)
			return null
		}
		for (const member of members) {
			const exchange = await postMember(member, nextUploads)
			if (exchange.status >= 300) return failOrAdopt(member, exchange)
			seededMembers.push(member)
			records.push((exchange.responseBody ?? {}) as Record_)
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
			buildCohort(schema, 1, ["baseline"], op.operationId)
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
