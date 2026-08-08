/**
 * Seeds the world once per run: resolves path parameters top-down, then creates a discriminating
 * cohort per entity.
 *
 * Prior art resolved fixtures per test case, which meant one unseedable resource produced dozens
 * of unrelated failures. Here a resolution failure is recorded once and everything downstream is
 * reported as BLOCKED against that single cause.
 */

import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { owningEntityName } from "../spec/graph.ts"
import type { Client } from "./client.ts"
import { type CohortMember, buildCohort } from "./fixture.ts"

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
	const [member] = buildCohort(schema ?? {}, options.seed, ["baseline"])
	const exchange = await client.request("POST", fillPath(createOp.path, scope.values), {
		body: member?.body ?? {},
		headers: options.authHeaders(),
	})
	if (exchange.status >= 300) {
		throw new SeedError(
			createOp.operationId,
			`${createOp.operationId} returned ${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 200)}`,
		)
	}
	return (exchange.responseBody ?? {}) as Record_
}

export function requestSchemaOf(
	op: OperationModel,
	model: SpecModel,
): Record<string, unknown> | null {
	const raw = model.rawOperations.get(op.operationId)
	const content = raw?.requestBody?.content
	if (content === undefined) return null
	for (const [mediaType, media] of Object.entries(content)) {
		if (mediaType.includes("json") && media.schema !== undefined) return media.schema
	}
	return null
}

export interface SeededCohort {
	members: CohortMember[]
	records: Record_[]
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
		throw new SeedError(createOp.operationId, `${createOp.operationId} declares no JSON request body`)
	}
	const members = buildCohort(schema, options.seed).slice(0, options.cohortSize ?? 7)
	const records: Record_[] = []
	const path = fillPath(createOp.path, scope.values)

	for (const member of members) {
		const exchange = await client.request("POST", path, {
			body: member.body,
			headers: options.authHeaders(),
		})
		if (exchange.status >= 300) {
			throw new SeedError(
				createOp.operationId,
				`seeding "${member.variant}" returned ${exchange.status}: ` +
					JSON.stringify(exchange.responseBody).slice(0, 200),
			)
		}
		records.push((exchange.responseBody ?? {}) as Record_)
	}
	return { members, records }
}
