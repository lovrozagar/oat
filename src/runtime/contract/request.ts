/**
 * A request built from an operation's own schema: its path parameters from the principal's roots,
 * a declared enum, `hooks.resolvePathValue` or an earlier success; its required query from
 * `x-bind`, the document or an example; its body from the request schema. What cannot be built
 * leaves the operation untested with the reason.
 */

import type { OperationObject } from "../../spec/types.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { requestContent } from "../../spec/collection/request.ts"
import { type ActionBind, applyActionBind } from "../effects/bind.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import type { GradeLedger } from "../grades.ts"
import { exampleOf, type Parameter, seenValue } from "./params.ts"
import type { ContractInput } from "./types.ts"

/** Every path parameter's value, or `null` once one cannot be resolved (and the operation is skipped). */
export async function pathValues(
	input: Pick<ContractInput, "client" | "grades" | "hooks" | "roots">,
	op: OperationModel,
	params: readonly Parameter[],
	headers: Record<string, string>,
): Promise<Record<string, string> | null> {
	const values: Record<string, string> = {}
	for (const name of op.pathParams) {
		const declared = params.find((param) => param.in === "path" && param.name === name)
		const value =
			input.roots[name] ??
			(declared?.schema?.enum === undefined ? undefined : exampleOf(declared.schema)) ??
			(await input.hooks.resolvePathValue?.({
				enumValues: (declared?.schema?.enum ?? []).map(String),
				headers,
				method: op.method,
				operationId: op.operationId,
				param: name,
				path: op.path,
			})) ??
			seenValue(input.client.transcript, name)
		if (value === undefined || value === null) {
			input.grades.skipped([op.operationId], `unresolved param ${name}`)
			return null
		}
		values[name] = value
	}
	return values
}

/**
 * Every required query parameter's value, or `null` once one cannot be resolved (and the operation
 * is skipped). What the operation names in `x-bind` is a value it accepts; a literal there beats a
 * guess. A pointer reads a record this call has none of, so it binds nothing here.
 */
export function queryValues(
	grades: GradeLedger,
	op: OperationModel,
	params: readonly Parameter[],
	bind: ActionBind | null,
): Record<string, string> | null {
	const bound = applyActionBind(bind, [], undefined, undefined).query
	const query: Record<string, string> = {}
	for (const param of params) {
		if (param.in !== "query" || param.required !== true) continue
		/* A built model's query parameters are named: a nameless one fails the build. */
		const name = param.name as string
		const value = bound[name] ?? op.requiredQuery[name] ?? exampleOf(param.schema)
		if (value === undefined) {
			grades.skipped([op.operationId], `unresolved query param ${name}`)
			return null
		}
		query[name] = value
	}
	return query
}

/** The request body, or `null` when the operation needs one oat cannot build (and is skipped). */
export function bodyOf(
	input: Pick<ContractInput, "grades" | "model" | "nonce" | "seed">,
	op: OperationModel,
	raw: OperationObject,
	bind: ActionBind | null,
): { body: unknown } | null {
	const { model } = input
	const content = requestContent(raw)
	if (content === null) return { body: undefined }
	if (!content.mediaType.includes("json")) {
		input.grades.skipped([op.operationId], `needs a ${content.mediaType} body oat cannot build without a scenario`)
		return null
	}
	/* The schema `requestSchemaOf` reads, from the same raw operation. One variant asked for, one
	 * member back, and its body is always an object. */
	const [member] = buildCohort(content.schema, input.seed, ["baseline"], op.operationId, {
		defs: model.defs,
		/* By operation, not by how many requests came before: the same run sends the same body. */
		nonce: `${input.nonce}c${op.operationId}`,
	}) as [CohortMember]
	return { body: applyActionBind(bind, [], undefined, member.body).body }
}
