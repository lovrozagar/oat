/** The caller's own create, when the spec has one: what it sends, and whether the next read shows it. */

import type { Client } from "../../client/client.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector, Outcome } from "../finding.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { applyResolveInput } from "../input.ts"
import { requestSchemaOf } from "../world/schema.ts"
import { SELF_CHECK_ID } from "./operations.ts"
import { operation, pathOf } from "./requests.ts"

export interface CreatedCaller {
	body: Record<string, unknown>
	exchange: Exchange
}

export interface CallerInput {
	auth: () => Record<string, string>
	client: Client
	entity: EntityModel
	model: SpecModel
	nonce?: string
	resolveInput?: Hooks["resolveInput"]
	seed?: number
}

/** Optional fields stay out. A create that pairs them (a label without its url) is a different check. */
function requiredSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const required = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: []
	if (required.length === 0) return schema
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return schema
	const source = properties as Record<string, unknown>
	const picked: Record<string, unknown> = {}
	for (const name of required) if (name in source) picked[name] = source[name]
	return { ...schema, properties: picked, required }
}

function propertyNames(schema: Record<string, unknown>): Set<string> {
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return new Set()
	return new Set(Object.keys(properties as Record<string, unknown>))
}

/** Whether the read shows a scalar the create sent, under the same field. */
export function callerEchoed(sent: Record<string, unknown>, body: unknown): boolean {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return false
	const record = body as Record<string, unknown>
	return Object.entries(sent).some(([key, value]) => {
		if (value === null || typeof value === "object") return false
		return record[key] === value
	})
}

/** The body the create sends: the schema's required fields, generated; or why none can be. */
function callerBody(
	input: CallerInput,
	findings: FindingCollector,
	schema: Record<string, unknown>,
	operationId: string,
): { body: Record<string, unknown> } | { outcome: Outcome } {
	const required = requiredSchema(schema)
	try {
		/* One variant asked for, one member made: buildCohort maps the variants it is given. */
		const member = buildCohort(required, input.seed ?? 1, ["baseline"], {
			distinct: propertyNames(required),
			...(input.nonce === undefined ? {} : { nonce: input.nonce }),
			operationId,
		})[0] as CohortMember
		return { body: member.body }
	} catch (error) {
		/* buildCohort reports every failure as an overflow naming why. */
		return { outcome: findings.unresolved(SELF_CHECK_ID, input.entity.name, (error as Error).message) }
	}
}

/** The create ran and the check ends on it: an unresolved body or a refused create. */
export function failedToCreate(created: CreatedCaller | Outcome | null): created is Outcome {
	return created !== null && "kind" in created
}

/** POST the spec's create. `null` when this caller record already exists. */
export async function createCaller(
	input: CallerInput,
	findings: FindingCollector,
): Promise<CreatedCaller | Outcome | null> {
	const createOp = operation(input.model, input.entity.create)
	if (createOp === undefined) return null
	const createPath = pathOf(createOp)
	if (createPath === null) {
		return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${createOp.operationId} needs a path id`)
	}
	const schema = requestSchemaOf(createOp, input.model)
	if (schema === null) {
		return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${createOp.operationId} declares no request body`)
	}
	const generated = callerBody(input, findings, schema, createOp.operationId)
	if ("outcome" in generated) return generated.outcome
	let body = generated.body
	if (input.resolveInput !== undefined) {
		body = await applyResolveInput(body, createOp.operationId, schema, input.resolveInput)
	}
	const exchange = await input.client.request(createOp.method, createPath, {
		body,
		headers: input.auth,
		operationId: createOp.operationId,
	})
	if (exchange.status < 200 || exchange.status >= 300) {
		return findings.backend(SELF_CHECK_ID, input.entity.name, {
			summary: "creating the caller failed",
			detail: `${createOp.operationId} returned ${exchange.status} for the signed-up caller.`,
			evidence: [exchange],
		})
	}
	return { body, exchange }
}
