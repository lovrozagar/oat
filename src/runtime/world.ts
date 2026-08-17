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
import type { Client, Exchange } from "./client.ts"
import { type CohortMember, buildCohort, isOverflowError, overflowFrom } from "./fixture.ts"
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
	const encoded = await encodeForOperation(
		createOp,
		model,
		member?.body ?? {},
		uploadContext(options),
		member?.variant ?? "baseline",
		0,
	)
	const exchange = await client.request("POST", fillPath(createOp.path, scope.values), {
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
		headers: options.authHeaders,
	})
	if (exchange.status >= 300) {
		throw new SeedError(
			createOp.operationId,
			`${createOp.operationId} returned ${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 300)}`,
			exchange.status,
		)
	}
	return (exchange.responseBody ?? {}) as Record_
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
	try {
		members = buildCohort(schema, options.seed, undefined, createOp.operationId).slice(0, options.cohortSize ?? 7)
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, createOp.operationId)
		throw error
	}
	const records: Record_[] = []
	const path = fillPath(createOp.path, scope.values)

	for (const member of members) {
		const encoded = await encodeForOperation(
			createOp,
			model,
			member.body,
			uploadContext(options),
			member.variant,
			records.length,
		)
		const exchange = await client.request("POST", path, {
			body: encoded.body,
			...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
			headers: options.authHeaders,
		})
		if (exchange.status >= 300) {
			/* Partial cohorts are still useful — a single rejected variant should not cost the
			 * entity all of its coverage. Only a completely empty cohort is fatal. */
			if (records.length > 0) break
			if (isDocumentedFeatureGateDenial(createOp, exchange.status, exchange.responseBody)) {
				return {
					featureGate: {
						detail: describeFeatureGate(createOp, exchange.responseBody),
						exchange,
						key: createOp.featureGate as string,
					},
					members,
					records,
				}
			}
			throw new SeedError(
				createOp.operationId,
				`seeding "${member.variant}" returned ${exchange.status}: ` +
					JSON.stringify(exchange.responseBody).slice(0, 300),
				exchange.status,
			)
		}
		records.push((exchange.responseBody ?? {}) as Record_)
	}
	return { featureGate: null, members, records }
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
