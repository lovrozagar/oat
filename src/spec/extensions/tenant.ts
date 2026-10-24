/** `x-tenant` and `x-root`: the path parameters that scope an operation or must be given to it. */

import type { Endpoint, OperationObject, ParameterObject } from "../types.ts"
import type { GapCollector } from "./gaps.ts"
import { ext } from "./tag.ts"

const TENANT_PARAM = /^(org(anization)?|tenant|workspace|account|project|app)_?(id|slug)?$/i

export function pathParameterNames(path: string): string[] {
	/* The pattern captures one or more characters, so every name is non-empty. */
	return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string)
}

export function readTenantSource(endpoint: Endpoint): "tag" | "heuristic" | null {
	const tag = ext(endpoint.op, "x-tenant")
	/* `false` is a shared catalog that happens to sit under a project path. */
	if (tag === false) return null
	if (typeof tag === "string") return "tag"
	const guess = pathParameterNames(endpoint.path).find((name) => TENANT_PARAM.test(name))
	return guess === undefined ? null : "heuristic"
}

export function readTenantParam(endpoint: Endpoint, gaps?: GapCollector): string | null {
	const tag = ext(endpoint.op, "x-tenant")
	if (tag === false) return null
	if (typeof tag === "string") return tag

	const guess = pathParameterNames(endpoint.path).find((name) => TENANT_PARAM.test(name))
	if (guess === undefined) return null
	gaps?.record(
		endpoint.operationId,
		"x-tenant",
		`assuming "${guess}" scopes this operation to a tenant, inferred from its name`,
	)
	return guess
}

/** Path parameters declared as roots — resources oat cannot create and must be given. */
export function readRootParams(op: OperationObject): string[] {
	const params = (op.parameters ?? []) as ParameterObject[]
	return params.filter((p) => p.in === "path" && (p as Record<string, unknown>)["x-root"] === true).map((p) => p.name)
}
