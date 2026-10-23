/** `x-entity`: which entity an operation acts on and how, declared or read off its path. */

import type { Endpoint } from "../types.ts"
import type { GapCollector } from "./gaps.ts"
import { extObject } from "./tag.ts"

export const ENTITY_ACTIONS = ["create", "list", "read", "update", "delete", "action"] as const

export type EntityAction = (typeof ENTITY_ACTIONS)[number]

const isEntityAction = (value: unknown): value is EntityAction => ENTITY_ACTIONS.some((action) => action === value)

/** The fields `x-entity` documents. */
export interface EntityTag {
	name: string
	action: EntityAction
	identity: string
	/** Where the answer keeps the record, or a list's rows. */
	recordPath: string
	/** Where a create's answer puts the made record's id. */
	createdIdFrom: string
}

export interface EntityRef {
	name: string
	action: EntityAction
	identity?: string
	source: "tag" | "heuristic"
}

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
	if (lower.endsWith("s")) return lower.slice(0, -1)
	return lower
}

const PARAM_SEGMENT = /^\{[^}]+\}$/

export function readEntity(endpoint: Endpoint, gaps?: GapCollector): EntityRef | null {
	const tag = extObject<EntityTag>(endpoint.op, "x-entity")
	if (typeof tag?.name === "string" && tag.name !== "" && isEntityAction(tag.action)) {
		const ref: EntityRef = { action: tag.action, name: tag.name, source: "tag" }
		if (typeof tag.identity === "string") ref.identity = tag.identity
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

/** `x-entity.recordPath`: the JSON path where this operation's answer keeps the record (or a list's rows). */
export function readRecordPath(endpoint: Endpoint): string | null {
	const path = extObject<EntityTag>(endpoint.op, "x-entity")?.recordPath
	return typeof path === "string" && path !== "" ? path : null
}

/** `x-entity.createdIdFrom`: the JSON path where a create's answer puts the made record's id. */
export function readCreatedIdFrom(endpoint: Endpoint): string | null {
	const from = extObject<EntityTag>(endpoint.op, "x-entity")?.createdIdFrom
	return typeof from === "string" && from !== "" ? from : null
}

/** The CRUD action a method takes at collection or item scope; `null` for a method that has none. */
function crudAction(method: string, itemScoped: boolean): EntityAction | null {
	if (method === "GET") return itemScoped ? "read" : "list"
	if (method === "POST") return itemScoped ? "action" : "create"
	if (method === "PUT" || method === "PATCH") return "update"
	if (method === "DELETE") return "delete"
	return null
}

/**
 * Heuristic: the last non-parameter segment names the collection; whether a parameter follows
 * it decides collection-scope vs item-scope; the method then decides the action.
 */
function inferEntity(endpoint: Endpoint): EntityRef | null {
	const segments = endpoint.path.split("/").filter(Boolean)
	const nounIndex = segments.findLastIndex((seg) => !PARAM_SEGMENT.test(seg))
	if (nounIndex === -1) return null
	/* Found by its index, so it is there. */
	const noun = segments[nounIndex] as string
	/* A version prefix is never an entity. */
	if (/^v\d+$/i.test(noun)) return null

	/* Every segment after the noun is a parameter, so any segment there makes it item-scoped. */
	const itemScoped = nounIndex < segments.length - 1

	const name = singularise(noun)
	const method = endpoint.method.toUpperCase()

	if (method !== "GET" && !itemScoped && method !== "POST") return { action: "action", name, source: "heuristic" }
	const action = crudAction(method, itemScoped)
	return action === null ? null : { action, name, source: "heuristic" }
}
