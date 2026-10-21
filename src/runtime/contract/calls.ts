/**
 * The contract floor's pass: every operation no check and no scenario graded is called once, or
 * judged on the call that already reached it.
 */

import { judges } from "../probe-judging.ts"
import type { OperationObject } from "../../spec/types.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { readActionBind } from "../effects/bind.ts"
import { fillPath } from "../fill-path.ts"
import { CONTRACT_CHECK_ID } from "./check.ts"
import { judge } from "./judge.ts"
import { parametersOf } from "./params.ts"
import { bodyOf, pathValues, queryValues } from "./request.ts"
import type { ContractCall, ContractInput } from "./types.ts"

export async function runContractCalls(input: ContractInput): Promise<void> {
	const { model, grades } = input
	const pending = model.operations.filter(
		(op) =>
			!op.destructive &&
			!input.owned.has(op.operationId) &&
			(input.mode === "full" || input.inScope(op.operationId)) &&
			!grades.judged(op.operationId) &&
			!grades.evidence.has(op.operationId),
	)
	if (pending.length === 0) return
	input.checksRun.add(CONTRACT_CHECK_ID)
	for (const op of pending) {
		if (input.stopped()) return
		try {
			await callOnce(input, op)
		} catch (error) {
			/* A refused credential or a dropped connection is not this operation's verdict. */
			grades.skipped(
				[op.operationId],
				`contract call could not be sent: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}

async function callOnce(input: ContractInput, op: OperationModel): Promise<void> {
	/* Every operation of a built model has its raw operation. */
	const raw = input.model.rawOperations.get(op.operationId) as OperationObject
	/* Already called on the way to something else — signup, a scenario's support step. Grade
	 * that exchange; calling again would only repeat a side effect. */
	const earlier = input.client.transcript.findLast(
		(exchange) =>
			exchange.operationId === op.operationId &&
			exchange.status >= 200 &&
			exchange.status < 300 &&
			judges("response.contract-call", exchange),
	)
	if (earlier !== undefined) {
		/* The transcript may have moved the body to disk; judge the body the server sent. */
		judge(input, { op, raw }, await input.client.hydrate(earlier))
		return
	}
	const call: ContractCall = {
		bind: readActionBind((raw as unknown as Record<string, unknown>)["x-bind"]),
		op,
		params: parametersOf(raw),
		raw,
	}
	const values = await pathValues(input, call)
	if (values === null) return
	const query = queryValues(input.grades, call)
	if (query === null) return
	const built = bodyOf(input, call)
	if (built === null) return
	const { body } = built
	/* A credential operation could end, rotate or spend the principal's own session: never sent with it. */
	const actor = input.credentials.operations.has(op.operationId)
		? await input.credentials.actorFor(op)
		: { as: { principal: input.principal } }
	if ("untested" in actor) {
		input.grades.skipped([op.operationId], actor.untested)
		return
	}
	const exchange = await input.client.request(op.method, fillPath(op.path, values), {
		...(body === undefined ? {} : { body }),
		as: actor.as,
		operationId: op.operationId,
		...(Object.keys(query).length === 0 ? {} : { query }),
	})
	judge(input, call, exchange)
}
