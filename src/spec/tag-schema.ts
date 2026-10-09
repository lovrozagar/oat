/**
 * Every oat tag, checked against its shape.
 *
 * Readers stay defensive — a tag they cannot use is ignored — but ignoring it silently meant a
 * typo read as an absence: `x-destructive: yes` was simply not destructive. A tag that is present
 * and malformed is a gap naming the tag and what is wrong with it, so `doctor` shows it.
 */

import type { GapCollector } from "./extensions.ts"
import type { OperationObject, ParameterObject } from "./types.ts"

type Check = (value: unknown) => string | null

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
const ROUTE = /^[A-Za-z]+\s+\/\S*$/

const string: Check = (value) => (typeof value === "string" && value !== "" ? null : "must be a non-empty string")
const boolean: Check = (value) => (typeof value === "boolean" ? null : "must be true or false")
const route: Check = (value) =>
	typeof value === "string" && ROUTE.test(value.trim()) ? null : 'must be a route like "GET /path"'
const strings: Check = (value) =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? null : "must be an array of strings"
const oneOf =
	(...allowed: string[]): Check =>
	(value) =>
		allowed.includes(value as string) ? null : `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`
const positive: Check = (value) => (typeof value === "number" && value > 0 ? null : "must be a positive number")

/** An object with these fields; `required` must be present, the rest are checked when present. */
const shape =
	(fields: Record<string, Check>, required: readonly string[] = []): Check =>
	(value) => {
		if (!isObject(value)) return "must be an object"
		for (const key of required) if (value[key] === undefined) return `needs "${key}"`
		for (const [key, entry] of Object.entries(value)) {
			const check = fields[key]
			if (check === undefined || entry === undefined) continue
			const problem = check(entry)
			if (problem !== null) return `"${key}" ${problem}`
		}
		return null
	}

const OPERATION_TAGS: Record<string, Check> = {
	"x-async": shape(
		{ idFrom: string, poll: string, pollIntervalMs: positive, successWhen: string, timeoutMs: positive, until: string },
		["poll"],
	),
	"x-cleanup": route,
	"x-cost": oneOf("low", "medium", "high"),
	"x-destructive": boolean,
	"x-entity": shape(
		{
			action: oneOf("create", "list", "read", "update", "delete", "action"),
			identity: string,
			name: string,
		},
		["name", "action"],
	),
	"x-feature-gate": string,
	"x-fresh-principal": boolean,
	"x-generated": strings,
	"x-idempotent": boolean,
	"x-immutable": strings,
	"x-invalidate": (value) =>
		Array.isArray(value) && value.every((item) => route(item) === null)
			? null
			: 'must be an array of routes like "GET /path"',
	"x-invite": shape(
		{
			accept: string,
			acceptFrom: oneOf("link"),
			grantPointer: string,
			granteeField: string,
			invite: string,
			revoke: string,
			tokenFrom: oneOf("response", "outOfBand"),
			tokenKind: string,
			tokenPointer: string,
		},
		["invite", "accept", "revoke"],
	),
	"x-query": (value) => (isObject(value) ? null : "must be an object"),
	"x-rate-limit": shape({ category: string, rps: positive }, ["category"]),
	"x-soft-delete": string,
	"x-tenant": string,
	"x-wait": shape({ operationId: string, pollIntervalMs: positive, timeoutMs: positive, until: string }, [
		"operationId",
	]),
}

/** Records a gap for every oat tag on `op` (and its parameters) that is present but malformed. */
export function validateTags(op: OperationObject, operationId: string, gaps: GapCollector): void {
	const record = op as Record<string, unknown>
	for (const [tag, check] of Object.entries(OPERATION_TAGS)) {
		if (record[tag] === undefined) continue
		const problem = check(record[tag])
		if (problem !== null) gaps.record(operationId, tag, `${tag} ${problem}; oat cannot use it`)
	}
	for (const parameter of (op.parameters ?? []) as ParameterObject[]) {
		const root = (parameter as Record<string, unknown>)["x-root"]
		if (root !== undefined && typeof root !== "boolean") {
			gaps.record(operationId, "x-root", `x-root on "${parameter.name}" must be true or false; oat cannot use it`)
		}
	}
}
