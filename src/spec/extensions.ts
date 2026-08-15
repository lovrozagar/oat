/**
 * Reads the `x-*` meta tags documented in the README.
 *
 * Every reader follows the same contract: explicit tag → heuristic → `null` plus a recorded
 * gap. oat never silently guesses; an unresolved tag becomes a COVERAGE_GAP in the report
 * naming the tag that would close it.
 */

import { deriveQueryConventions } from "./conventions.ts"
import { normalisePath } from "./load.ts"
import type { Endpoint, OperationObject, ParameterObject } from "./types.ts"

export type EntityAction = "create" | "list" | "read" | "update" | "delete" | "action"

export interface EntityRef {
	name: string
	action: EntityAction
	identity?: string
	source: "tag" | "heuristic"
}

export interface QueryCapability {
	filterable: string[]
	sortable: string[]
	searchable: string[]
	selectable: string[]
	maxLimit?: number
	defaultOrder?: string
	stableTiebreak?: string
	source: "tag" | "heuristic"
}

export interface AsyncSpec {
	poll: string
	idFrom?: string
	until?: string
	successWhen?: string
	timeoutMs: number
	pollIntervalMs: number
}

export interface EffectSpec {
	entity: string
	op: "create" | "append" | "update" | "delete" | "replace"
	count?: number
}

export interface Gap {
	operationId: string
	tag: string
	detail: string
}

export class GapCollector {
	readonly gaps: Gap[] = []
	record(operationId: string, tag: string, detail: string): void {
		this.gaps.push({ detail, operationId, tag })
	}
}

function ext<T>(op: OperationObject, key: string): T | undefined {
	const value = (op as Record<string, unknown>)[key]
	return value === undefined ? undefined : (value as T)
}

/* ---------------------------------------------------------------- x-invalidate */

export function readInvalidate(op: OperationObject): string[] {
	const raw = ext<unknown>(op, "x-invalidate")
	if (!Array.isArray(raw)) return []
	return raw.filter((r): r is string => typeof r === "string").map(normaliseRouteRef)
}

function normaliseRouteRef(ref: string): string {
	const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(ref)
	if (!match?.[1] || !match[2]) return ref.trim()
	return `${match[1].toUpperCase()} ${normalisePath(match[2])}`
}

/* -------------------------------------------------------------------- x-entity */

const IRREGULAR_PLURALS: Record<string, string> = {
	addresses: "address",
	batches: "batch",
	campuses: "campus",
	categories: "category",
	children: "child",
	companies: "company",
	entities: "entity",
	inboxes: "inbox",
	indices: "index",
	people: "person",
	properties: "property",
	queries: "query",
	statuses: "status",
}

/**
 * Word endings that are not plural markers. Without these, `status` becomes `statu` and
 * `analysis` becomes `analysi` — the kind of mangling that turns a readable report into one
 * nobody trusts.
 */
const NON_PLURAL_ENDINGS = /(?:us|ss|is|os|as|ics|ews|ess|ous|sis)$/

export function singularise(word: string): string {
	const lower = word.toLowerCase()
	const irregular = IRREGULAR_PLURALS[lower]
	if (irregular !== undefined) return irregular
	if (/(ches|shes|sses|xes|zes)$/.test(lower)) return lower.slice(0, -2)
	if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`
	if (NON_PLURAL_ENDINGS.test(lower)) return lower
	if (/s$/.test(lower)) return lower.slice(0, -1)
	return lower
}

const PARAM_SEGMENT = /^\{[^}]+\}$/

export function readEntity(endpoint: Endpoint, gaps?: GapCollector): EntityRef | null {
	const tag = ext<{ name?: string; action?: string; identity?: string }>(endpoint.op, "x-entity")
	if (tag?.name && tag.action) {
		const ref: EntityRef = {
			action: tag.action as EntityAction,
			name: tag.name,
			source: "tag",
		}
		if (tag.identity !== undefined) ref.identity = tag.identity
		return ref
	}

	const inferred = inferEntity(endpoint)
	if (inferred === null) {
		gaps?.record(
			endpoint.operationId,
			"x-entity",
			`path "${endpoint.path}" does not follow /<plural>/{id}; entity could not be inferred, ` +
				"so this operation gets no lifecycle coverage",
		)
		return null
	}
	return inferred
}

/**
 * Heuristic: the last non-parameter segment names the collection; whether a parameter follows
 * it decides collection-scope vs item-scope; the method then decides the action.
 */
function inferEntity(endpoint: Endpoint): EntityRef | null {
	const segments = endpoint.path.split("/").filter(Boolean)
	let nounIndex = -1
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i]
		if (seg !== undefined && !PARAM_SEGMENT.test(seg)) {
			nounIndex = i
			break
		}
	}
	if (nounIndex === -1) return null

	const noun = segments[nounIndex]
	if (noun === undefined) return null
	/* A version prefix is never an entity. */
	if (/^v\d+$/i.test(noun)) return null

	const trailing = segments.slice(nounIndex + 1)
	const itemScoped = trailing.length > 0 && trailing.every((s) => PARAM_SEGMENT.test(s))
	/* A trailing verb segment (`/rows/aggregate`, `/tables/{id}/restore`) is an action, not CRUD. */
	const isSubAction = nounIndex < segments.length - 1 && !itemScoped

	const name = singularise(noun)
	const method = endpoint.method.toUpperCase()

	if (isSubAction || (method !== "GET" && !itemScoped && method !== "POST")) {
		return { action: "action", name, source: "heuristic" }
	}

	let action: EntityAction
	switch (method) {
		case "GET":
			action = itemScoped ? "read" : "list"
			break
		case "POST":
			action = itemScoped ? "action" : "create"
			break
		case "PUT":
		case "PATCH":
			action = "update"
			break
		case "DELETE":
			action = "delete"
			break
		default:
			return null
	}
	return { action, name, source: "heuristic" }
}

/* --------------------------------------------------------------------- x-query */

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"])

export function readQueryCapability(
	endpoint: Endpoint,
	itemSchema: Record<string, unknown> | null,
	gaps?: GapCollector,
): QueryCapability | null {
	const tag = ext<Record<string, unknown>>(endpoint.op, "x-query")
	if (tag !== undefined) {
		const cap: QueryCapability = {
			filterable: strArray(tag.filterable),
			searchable: strArray(tag.searchable),
			selectable: strArray(tag.selectable),
			sortable: strArray(tag.sortable),
			source: "tag",
		}
		if (typeof tag.maxLimit === "number") cap.maxLimit = tag.maxLimit
		if (typeof tag.defaultOrder === "string") cap.defaultOrder = tag.defaultOrder
		if (typeof tag.stableTiebreak === "string") cap.stableTiebreak = tag.stableTiebreak
		return cap
	}

	const params = (endpoint.op.parameters ?? []).filter((p) => p.in === "query")
	/* Same aliases the checks already use — `sort`/`fields`/`q`/`per_page`, not only the
	 * fixture spellings `filter`/`order`/`select`/`limit`. Pagination-only params do not
	 * count: a `page`/`limit` list is not a query grammar. */
	const conventions = deriveQueryConventions(params, null)
	const roles = [conventions.filter, conventions.order, conventions.select, conventions.search].filter(
		(name): name is string => name !== undefined,
	)
	if (roles.length === 0) return null

	const scalars = itemSchema === null ? [] : scalarProperties(itemSchema)
	gaps?.record(
		endpoint.operationId,
		"x-query",
		`endpoint accepts ${roles.join("/")} ` +
			`but does not declare which fields support them. Assuming all ${scalars.length} scalar ` +
			"properties, which will produce false failures on unindexed fields",
	)

	const cap: QueryCapability = {
		filterable: scalars,
		searchable: scalars.filter((f) => /name|title|slug|label|description|email/i.test(f)),
		selectable: scalars,
		sortable: scalars,
		source: "heuristic",
	}
	if (conventions.limit !== undefined) {
		const limitParam = params.find((p) => p.name === conventions.limit)
		const max = limitParam?.schema?.maximum
		if (typeof max === "number") cap.maxLimit = max
	}
	return cap
}

function scalarProperties(schema: Record<string, unknown>): string[] {
	const props = schema.properties
	if (props === null || typeof props !== "object") return []
	const out: string[] = []
	for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object") continue
		if (isScalarSchema(raw as Record<string, unknown>)) out.push(name)
	}
	return out
}

function isScalarSchema(schema: Record<string, unknown>): boolean {
	const type = schema.type
	if (typeof type === "string") return SCALAR_TYPES.has(type)
	if (Array.isArray(type)) return type.every((t) => t === "null" || SCALAR_TYPES.has(String(t)))
	/* `oneOf: [{type: string}, {type: null}]` is the nullable-scalar idiom. */
	const oneOf = schema.oneOf ?? schema.anyOf
	if (Array.isArray(oneOf)) {
		return oneOf.every(
			(branch) =>
				branch !== null &&
				typeof branch === "object" &&
				isScalarSchema(branch as Record<string, unknown>),
		)
	}
	return false
}

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/* --------------------------------------------------- x-async / x-effects / misc */

export function readAsync(op: OperationObject): AsyncSpec | null {
	const tag = ext<Record<string, unknown>>(op, "x-async")
	if (tag === undefined || typeof tag.poll !== "string") return null
	const spec: AsyncSpec = {
		poll: tag.poll,
		pollIntervalMs: typeof tag.pollIntervalMs === "number" ? tag.pollIntervalMs : 2000,
		timeoutMs: typeof tag.timeoutMs === "number" ? tag.timeoutMs : 120_000,
	}
	if (typeof tag.idFrom === "string") spec.idFrom = tag.idFrom
	if (typeof tag.until === "string") spec.until = tag.until
	if (typeof tag.successWhen === "string") spec.successWhen = tag.successWhen
	return spec
}

export function readEffects(op: OperationObject): EffectSpec[] {
	const raw = ext<unknown>(op, "x-effects")
	if (!Array.isArray(raw)) return []
	const out: EffectSpec[] = []
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue
		const rec = item as Record<string, unknown>
		if (typeof rec.entity !== "string" || typeof rec.op !== "string") continue
		const effect: EffectSpec = { entity: rec.entity, op: rec.op as EffectSpec["op"] }
		if (typeof rec.count === "number") effect.count = rec.count
		out.push(effect)
	}
	return out
}

export interface InviteSpec {
	invite: string
	accept: string
	revoke: string
	granteeField: string
	tokenPointer: string
	grantPointer: string
}

export function readInvite(op: OperationObject): InviteSpec | null {
	const tag = ext<Record<string, unknown>>(op, "x-invite")
	if (tag === undefined) return null
	const invite = typeof tag.invite === "string" ? tag.invite : undefined
	const accept = typeof tag.accept === "string" ? tag.accept : undefined
	const revoke = typeof tag.revoke === "string" ? tag.revoke : undefined
	if (invite === undefined || accept === undefined || revoke === undefined) return null
	return {
		accept,
		grantPointer: typeof tag.grantPointer === "string" ? tag.grantPointer : "$.grant_id",
		granteeField: typeof tag.granteeField === "string" ? tag.granteeField : "key",
		invite,
		revoke,
		tokenPointer: typeof tag.tokenPointer === "string" ? tag.tokenPointer : "$.token",
	}
}

export function readSoftDelete(op: OperationObject): string | null {
	const value = ext<unknown>(op, "x-soft-delete")
	return typeof value === "string" ? value : null
}

export function readImmutable(op: OperationObject): string[] {
	return strArray(ext<unknown>(op, "x-immutable"))
}

export function readGenerated(op: OperationObject, bodySchema: unknown): string[] {
	const declared = strArray(ext<unknown>(op, "x-generated"))
	if (declared.length > 0) return declared
	/* `readOnly: true` carries the same meaning and is standard OpenAPI. */
	if (bodySchema === null || typeof bodySchema !== "object") return []
	const props = (bodySchema as Record<string, unknown>).properties
	if (props === null || typeof props !== "object") return []
	return Object.entries(props as Record<string, unknown>)
		.filter(([, v]) => v !== null && typeof v === "object" && (v as { readOnly?: unknown }).readOnly === true)
		.map(([k]) => k)
}

export function readCost(op: OperationObject): "low" | "medium" | "high" {
	const value = ext<unknown>(op, "x-cost")
	return value === "high" || value === "medium" ? value : "low"
}

export function readFlag(op: OperationObject, key: string): boolean {
	return ext<unknown>(op, key) === true
}

export function readCleanup(op: OperationObject): string | null {
	const value = ext<unknown>(op, "x-cleanup")
	return typeof value === "string" ? normaliseRouteRef(value) : null
}

/* -------------------------------------------------------------------- x-tenant */

const TENANT_PARAM = /^(org(anization)?|tenant|workspace|account|project|app)_?(id|slug)?$/i

export function readTenantSource(endpoint: Endpoint): "tag" | "heuristic" | null {
	if (typeof ext<unknown>(endpoint.op, "x-tenant") === "string") return "tag"
	const guess = pathParameterNames(endpoint.path).find((name) => TENANT_PARAM.test(name))
	return guess === undefined ? null : "heuristic"
}

export function readTenantParam(endpoint: Endpoint, gaps?: GapCollector): string | null {
	const tag = ext<unknown>(endpoint.op, "x-tenant")
	if (typeof tag === "string") return tag

	const pathParams = pathParameterNames(endpoint.path)
	const guess = pathParams.find((name) => TENANT_PARAM.test(name))
	if (guess === undefined) return null
	gaps?.record(
		endpoint.operationId,
		"x-tenant",
		`assuming "${guess}" scopes this operation to a tenant, inferred from its name`,
	)
	return guess
}

export function pathParameterNames(path: string): string[] {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "").filter(Boolean)
}

/** Path parameters declared as roots — resources oat cannot create and must be given. */
export function readRootParams(op: OperationObject): string[] {
	const params = (op.parameters ?? []) as ParameterObject[]
	return params
		.filter((p) => p.in === "path" && (p as Record<string, unknown>)["x-root"] === true)
		.map((p) => p.name)
}
