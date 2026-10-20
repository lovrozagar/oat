/**
 * A request built from an operation's own schema: its path parameters from the principal's roots,
 * a declared enum, `hooks.resolvePathValue` or an earlier success about the same kind of record; its
 * required query from `x-bind`, the document or an example; its body from the request schema. What
 * cannot be built leaves the operation untested with the reason.
 */

import { requestContent } from "../../spec/collection/request.ts"
import { applyActionBind } from "../effects/bind.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import type { GradeLedger } from "../grades.ts"
import { exampleOf, seenValue } from "./params.ts"
import type { ContractCall, ContractInput } from "./types.ts"

/** Every path parameter's value, or `null` once one cannot be resolved (and the operation is skipped). */
export async function pathValues(
	input: Pick<ContractInput, "acting" | "client" | "grades" | "hooks" | "model" | "principal" | "roots">,
	{ op, params }: Pick<ContractCall, "op" | "params">,
): Promise<Record<string, string> | null> {
	const values: Record<string, string> = {}
	for (const name of op.pathParams) {
		const declared = params.find((param) => param.in === "path" && param.name === name)
		const value =
			input.roots[name] ??
			(declared?.schema?.enum === undefined ? undefined : exampleOf(declared.schema)) ??
			(await askHook(input, { declared, name, op })) ??
			seenFor(input, op, name)
		if (value === undefined || value === null) {
			input.grades.skipped([op.operationId], `unresolved param ${name}`)
			return null
		}
		values[name] = value
	}
	return values
}

/* A path template with its parameter names dropped: `/projects/{project_id}/jobs` is `/projects/{}/jobs`. */
const shapeOf = (path: string): string => path.replaceAll(/\{[^}]*\}/g, "{}")

/*
 * The value an earlier success returned under `name`. A bare record key (`id`, `uuid`, `slug`) names
 * the record of the body it sits in, so only an answer about the parameter's own collection holds
 * one: its list or create, or one of its items. Any other resource's newest record answers `id`
 * too, and is the wrong record. A qualified name (`thing_id`, `thingId`) names its entity, and any
 * answer's value under it will do.
 */
function seenFor(
	input: Pick<ContractInput, "client" | "model">,
	op: ContractCall["op"],
	name: string,
): string | undefined {
	const { redactor, transcript } = input.client
	if (!/^[a-z0-9]+$/.test(name)) return seenValue(transcript, name, redactor)
	/* A built model's path parameters each stand in its path. */
	const at = op.path.indexOf(`{${name}}`)
	const collection = shapeOf(op.path.slice(0, op.path.lastIndexOf("/", at)))
	const own = transcript.filter((exchange) => {
		const id = exchange.operationId
		const path = id === undefined ? undefined : input.model.byOperationId.get(id)?.path
		return path !== undefined && [collection, `${collection}/{}`].includes(shapeOf(path))
	})
	return seenValue(own, name, redactor)
}

/* `hooks.resolvePathValue`, told who acts and what the operation would send as it: never raw headers. */
async function askHook(
	input: Pick<ContractInput, "acting" | "hooks" | "principal" | "roots">,
	asked: { op: ContractCall["op"]; name: string; declared: ContractCall["params"][number] | undefined },
): Promise<string | null | undefined> {
	const hook = input.hooks.resolvePathValue
	if (hook === undefined) return undefined
	const { op, name, declared } = asked
	const sending = await input.acting.sending(op.operationId)
	return hook({
		enumValues: (declared?.schema?.enum ?? []).map(String),
		identity: input.acting.identity,
		method: op.method,
		operationId: op.operationId,
		param: name,
		path: op.path,
		principal: input.principal,
		scope: input.roots,
		...sending,
	})
}

/**
 * Every required query parameter's value, or `null` once one cannot be resolved (and the operation
 * is skipped). What the operation names in `x-bind` is a value it accepts; a literal there beats a
 * guess. A pointer reads a record this call has none of, so it binds nothing here.
 */
export function queryValues(
	grades: GradeLedger,
	{ op, params, bind }: Pick<ContractCall, "bind" | "op" | "params">,
): Record<string, string> | null {
	const bound = applyActionBind(bind, { records: [], beforeBody: undefined }, undefined).query
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
	{ op, raw, bind }: Pick<ContractCall, "bind" | "op" | "raw">,
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
	const [member] = buildCohort(content.schema, input.seed, {
		variants: ["baseline"],
		defs: model.defs,
		/* By operation, not by how many requests came before: the same run sends the same body. */
		nonce: `${input.nonce}c${op.operationId}`,
		operationId: op.operationId,
	}) as [CohortMember]
	return { body: applyActionBind(bind, { records: [], beforeBody: undefined }, member.body).body }
}
