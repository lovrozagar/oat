/** GET actions on the caller with no path id: each asked about what the create sent, and must answer about it. */

import type { Client } from "../../client/client.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector, Outcome } from "../finding.ts"
import type { CreatedCaller } from "./create.ts"
import { SELF_CHECK_ID, selfActionIds } from "./operations.ts"
import { operation } from "./requests.ts"

/** The action's query, from the scalars the create sent under its parameter names. */
function actionQuery(op: OperationModel, created: CreatedCaller | null): Record<string, string> {
	const query: Record<string, string> = {}
	for (const name of op.queryParamNames) {
		const value = created?.body[name]
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			query[name] = String(value)
		}
	}
	return query
}

/** A field the answer names that differs from what the query asked for, or `null`. */
function answeredOther(response: Exchange, query: Record<string, string>): string | null {
	if (response.responseBody === null || typeof response.responseBody !== "object") return null
	const record = response.responseBody as Record<string, unknown>
	for (const [name, value] of Object.entries(query)) {
		if (Object.prototype.hasOwnProperty.call(record, name) && String(record[name]) !== value) return name
	}
	return null
}

export async function runSelfActions(
	input: {
		auth: () => Record<string, string>
		client: Client
		entity: EntityModel
		model: SpecModel
	},
	findings: FindingCollector,
	created: CreatedCaller | null,
): Promise<Outcome | null> {
	for (const id of selfActionIds(input.entity, input.model)) {
		/* An action id comes from the model, so its operation is there. */
		const op = operation(input.model, id) as OperationModel
		const query = actionQuery(op, created)
		const missing = op.queryParamNames.filter((name) => query[name] === undefined)
		if (missing.length > 0) {
			return findings.unresolved(
				SELF_CHECK_ID,
				input.entity.name,
				`${op.operationId} needs ${missing.join(", ")} and the create did not send it`,
			)
		}
		const response = await input.client.request(op.method, op.path, {
			headers: input.auth,
			operationId: op.operationId,
			query,
		})
		if (response.status !== 200) {
			return findings.backend(
				SELF_CHECK_ID,
				input.entity.name,
				"the caller query failed",
				`${op.operationId} returned ${response.status} for ${JSON.stringify(query)}.`,
				[response],
			)
		}
		const other = answeredOther(response, query)
		if (other !== null) {
			const record = response.responseBody as Record<string, unknown>
			return findings.backend(
				SELF_CHECK_ID,
				input.entity.name,
				"the caller query answered about a different value",
				`${op.operationId} was asked for ${other}=${query[other]} and returned ${JSON.stringify(record[other])}.`,
				[response],
			)
		}
	}
	return null
}
