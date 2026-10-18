/**
 * The contract floor's pass: every operation no check and no scenario graded is called once, or
 * judged on the call that already reached it.
 */

import type { OperationObject } from "../../spec/types.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { readActionBind } from "../effects/bind.ts"
import { fillPath } from "../fill-path.ts"
import { CONTRACT_CHECK_ID } from "./check.ts"
import { judge } from "./judge.ts"
import { parametersOf } from "./params.ts"
import { bodyOf, pathValues, queryValues } from "./request.ts"
import type { ContractInput } from "./types.ts"

export async function runContractCalls(input: ContractInput): Promise<void> {
	const { model, grades } = input
	const pending = model.operations.filter(
		(op) =>
			!op.destructive &&
			!input.owned.has(op.operationId) &&
			(input.mode === "full" || input.inScope(op.operationId)) &&
			(grades.ran.get(op.operationId)?.size ?? 0) === 0 &&
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
		(exchange) => exchange.operationId === op.operationId && exchange.status >= 200 && exchange.status < 300,
	)
	if (earlier !== undefined) {
		/* The transcript may have moved the body to disk; judge the body the server sent. */
		judge(input, op, raw, await input.client.hydrate(earlier))
		return
	}
	const params = parametersOf(raw)
	const headers = input.auth()
	const values = await pathValues(input, op, params, headers)
	if (values === null) return
	const bind = readActionBind((raw as unknown as Record<string, unknown>)["x-bind"])
	const query = queryValues(input.grades, op, params, bind)
	if (query === null) return
	const built = bodyOf(input, op, raw, bind)
	if (built === null) return
	const { body } = built
	const exchange = await input.client.request(op.method, fillPath(op.path, values), {
		...(body === undefined ? {} : { body }),
		headers,
		operationId: op.operationId,
		...(Object.keys(query).length === 0 ? {} : { query }),
	})
	judge(input, op, raw, exchange)
}
