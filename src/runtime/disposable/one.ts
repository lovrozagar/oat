/**
 * One destructive operation, run as the second user: its path filled from that user's lists, its
 * body from the schema and what the signup knows, and its answer graded.
 */

import type { OperationObject } from "../../spec/types.ts"
import { requestSchema } from "../../spec/collection/request.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { applyResolveInput } from "../input.ts"
import { afterCall, type Blame } from "./after.ts"
import { DISPOSABLE_CHECK_ID } from "./check.ts"
import { bodyFor, identityOf, parentList, recordsOf } from "./lists.ts"
import type { DisposableInput, Session } from "./types.ts"

/** A destructive operation, the session it runs as, the caller read, and whether it ends the session. */
export interface DisposableCall {
	op: OperationModel
	session: Session
	read: OperationModel
	ends: boolean
}

export async function runOne(input: DisposableInput, call: DisposableCall): Promise<void> {
	const { op, session } = call
	const blame: Blame = {
		collector: input.findings.attributed([op.operationId]).ownedBy(DISPOSABLE_CHECK_ID),
		entity: op.entity ?? call.read.entity ?? "caller",
	}
	const values = await pathValues(input, op, session)
	if (values === null) return
	const body = await destructiveBody(input, op, session)
	const called = await input.client.request(op.method, fillPath(op.path, values), {
		as: { principal: session.principal },
		...(body === undefined ? {} : { body }),
		operationId: op.operationId,
	})
	if (called.status >= 500) {
		input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
		blame.collector.backend(DISPOSABLE_CHECK_ID, blame.entity, {
			summary: "the disposable call failed",
			detail: `${op.operationId} returned ${called.status}.`,
			evidence: [called],
		})
		return
	}
	if (called.status < 200 || called.status >= 300) {
		input.grades.skipped([op.operationId], `destructive call returned ${called.status}; a scenario must set the scene`)
		return
	}
	input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
	await afterCall(input, { ...call, blame, called, values })
}

/** The path, each parameter the session's scope lacks read from the list one level up; `null` once one cannot be. */
async function pathValues(
	input: DisposableInput,
	op: OperationModel,
	session: Session,
): Promise<Record<string, string> | null> {
	const values: Record<string, string> = { ...session.scope }
	for (const param of op.pathParams) {
		if (values[param] !== undefined) continue
		const list = parentList(input.model, op)
		if (list === undefined) {
			input.grades.skipped([op.operationId], `unresolved param ${param}`)
			return null
		}
		const listed = await input.client.request(list.method, fillPath(list.path, values), {
			as: { principal: session.principal },
			operationId: list.operationId,
		})
		const field = identityOf(list, input.model, param)
		const row = recordsOf(listed.responseBody, list, input.model).find((item) => typeof item[field] === "string")
		if (row === undefined) {
			input.grades.skipped([op.operationId], "the list returned no id")
			return null
		}
		values[param] = String(row[field])
	}
	return values
}

/** The schema-built body with what the signup knows overlaid; none when the operation takes none. */
async function destructiveBody(input: DisposableInput, op: OperationModel, session: Session): Promise<unknown> {
	/* Every operation of a built model has its raw operation. */
	const schema = requestSchema(input.model.rawOperations.get(op.operationId) as OperationObject)
	let generated: Record<string, unknown> = {}
	if (schema !== null) {
		try {
			/* One variant asked for, one member back, and its body is always an object. */
			const [member] = buildCohort(schema, input.seed ?? 1, {
				variants: ["baseline"],
				nonce: `${input.nonce ?? "user"}d`,
				operationId: op.operationId,
			}) as [CohortMember]
			generated = member.body
		} catch {
			/* `buildCohort` throws only an overflow (a `FixtureOverflow`, or a `RangeError` past its
			 * depth): the body stays empty, and what the signup knows still fills it. */
		}
		if (input.resolveInput !== undefined) {
			generated = await applyResolveInput(generated, input.resolveInput, { operationId: op.operationId, schema })
		}
	}
	return bodyFor(schema, session.known, generated)
}
