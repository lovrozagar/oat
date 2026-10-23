/**
 * Who the self check acts as. The caller's record is the caller's own: its update never picks a
 * field the caller signs in with (`protectedFields`). When proving the update or the create needs
 * one (the only field there is to change, a field the create requires), the run's disposable
 * principal acts instead, whose record is its to change; with none, the check stands down, naming it.
 */

import type { OperationModel } from "../../spec/graph/types.ts"
import type { JsonSchema } from "../../spec/types.ts"
import { requestContentOf } from "../body/encode.ts"
import type { Outcome } from "../finding.ts"
import { protectedFields, protectedReason } from "../own-record.ts"
import { requestSchemaOf } from "../world/schema.ts"
import type { SelfInput } from "./input.ts"
import { SELF_CHECK_ID } from "./operations.ts"
import { probeField } from "./probe-field.ts"
import { operation, pathOf } from "./requests.ts"
import type { SelfRun } from "./verdicts.ts"

/** The principal the check acts as, and the fields its update must leave alone. */
export interface Acting {
	principal: string
	avoid: ReadonlySet<string>
}

type Guard = (op: OperationModel, names: Iterable<string>) => Set<string>

/* What the update must leave alone, and why it needs a disposable principal when the only field it could change is one. */
function updateNeeds(input: SelfInput, run: SelfRun, guarded: Guard): { avoid: ReadonlySet<string>; needs?: string } {
	const { updateOp } = run
	if (updateOp === undefined || pathOf(updateOp) === null) return { avoid: new Set() }
	const schema = requestContentOf(updateOp, input.model)?.schema
	const avoid = guarded(updateOp, Object.keys(propertiesOf(schema)))
	const wanted = probeField(schema)
	if (wanted === null || probeField(schema, avoid) !== null) return { avoid }
	return { avoid, needs: protectedReason(updateOp.operationId, input.principal, [wanted.name]) }
}

/* Why the create needs a disposable principal: a field it requires is one the caller signs in with. */
function createNeeds(input: SelfInput, guarded: Guard): string | undefined {
	const createOp = operation(input.model, input.entity.create)
	const created = createOp === undefined || pathOf(createOp) === null ? null : requestSchemaOf(createOp, input.model)
	if (createOp === undefined || created === null) return undefined
	const required = Array.isArray(created.required) ? created.required.filter((name) => typeof name === "string") : []
	const fields = [...guarded(createOp, required)]
	return fields.length > 0 ? protectedReason(createOp.operationId, input.principal, fields) : undefined
}

export async function actingAs(input: SelfInput, run: SelfRun): Promise<Acting | Outcome> {
	const records = input.ownRecords
	const identity = records?.identityOf(input.principal)
	if (records === undefined || identity === undefined) return { avoid: new Set(), principal: input.principal }
	const guarded: Guard = (op, names) => protectedFields(records.signIn, { identity, op, path: {} }, names)
	const update = updateNeeds(input, run, guarded)
	const needs = [update.needs, createNeeds(input, guarded)].filter((need) => need !== undefined)
	if (needs.length === 0) return { avoid: update.avoid, principal: input.principal }
	const disposable = await records.disposable()
	if (typeof disposable === "string") return { avoid: new Set(), principal: disposable }
	return run.findings.unresolved(
		SELF_CHECK_ID,
		run.entity.name,
		`${needs.join("; ")}, and no disposable principal could send it: ${disposable.blocked}`,
	)
}

function propertiesOf(schema: JsonSchema | undefined): Record<string, unknown> {
	const properties = schema?.properties
	return properties !== null && typeof properties === "object" && !Array.isArray(properties)
		? (properties as Record<string, unknown>)
		: {}
}
