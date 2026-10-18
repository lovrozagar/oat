/**
 * Every oat tag, checked against its shape.
 *
 * Readers stay defensive — a tag they cannot use is ignored — but ignoring it silently meant a
 * typo read as an absence: `x-destructive: yes` was simply not destructive. A tag that is present
 * and malformed is a gap naming the tag and what is wrong with it, so `doctor` shows it.
 */

import type { GapCollector } from "../extensions/gaps.ts"
import type { OperationObject, ParameterObject } from "../types.ts"
import { type Check, checkShape, type Fields, flag, oneOf, positive, route, text, textMap, texts } from "./checks.ts"
import { xQuery } from "./query.ts"

const ASYNC: Fields = {
	idFrom: text,
	poll: text,
	pollIntervalMs: positive,
	successWhen: text,
	timeoutMs: positive,
	until: text,
}

const ENTITY: Fields = {
	action: (value) => oneOf(value, ["create", "list", "read", "update", "delete", "action"]),
	createdIdFrom: text,
	identity: text,
	name: text,
	recordPath: text,
}

const INVITE: Fields = {
	accept: text,
	acceptFrom: (value) => oneOf(value, ["link"]),
	credentialFrom: text,
	grantPointer: text,
	granteeField: text,
	grants: text,
	invite: text,
	revoke: text,
	tokenFrom: (value) => oneOf(value, ["response", "outOfBand"]),
	tokenKind: text,
	tokenPointer: text,
}

const BIND: Fields = { body: textMap, path: textMap, query: textMap }

const RATE_LIMIT: Fields = { category: text, rps: positive }

const WAIT: Fields = { operationId: text, pollIntervalMs: positive, timeoutMs: positive, until: text }

function entity(value: unknown): string | null {
	const problem = checkShape(value, ENTITY)
	if (problem !== null) return problem
	/* Where the answer keeps the record or its id may be declared alone; naming the entity
	 * still takes both its name and the operation's action. */
	const tag = value as Record<string, unknown>
	const located = tag.createdIdFrom !== undefined || tag.recordPath !== undefined
	if (tag.name === undefined && (tag.action !== undefined || !located)) return 'needs "name"'
	if (tag.action === undefined && (tag.name !== undefined || !located)) return 'needs "action"'
	return null
}

/* In the order their gaps are reported. */
const OPERATION_TAGS: Readonly<Record<string, Check>> = {
	"x-before": text,
	"x-bind": (value) => checkShape(value, BIND),
	"x-async": (value) => checkShape(value, ASYNC, ["poll"]),
	"x-cleanup": route,
	"x-cost": (value) => oneOf(value, ["low", "medium", "high"]),
	"x-destructive": flag,
	"x-entity": entity,
	"x-feature-gate": text,
	"x-fresh-principal": flag,
	"x-generated": texts,
	"x-idempotent": flag,
	"x-immutable": texts,
	"x-invalidate": (value) =>
		Array.isArray(value) && value.every((item) => route(item) === null)
			? null
			: 'must be an array of routes like "GET /path"',
	"x-invite": (value) => checkShape(value, INVITE, ["invite", "accept", "revoke"]),
	"x-query": xQuery,
	"x-rate-limit": (value) => checkShape(value, RATE_LIMIT, ["category"]),
	"x-soft-delete": text,
	"x-tenant": (value) =>
		value === false || (typeof value === "string" && value !== "") ? null : "must be a path parameter name or false",
	"x-wait": (value) => checkShape(value, WAIT, ["operationId"]),
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
