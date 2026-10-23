import type { Client } from "../../../../../client/client.ts"
import type { Exchange } from "../../../../exchange.ts"
import { SchemaValidator } from "../../../../validate.ts"
import type { SpecModel } from "../../../../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import type { Listed } from "../../../core/context.ts"
import {
	type Answer,
	contextFor,
	exchange,
	exchangeOf,
	modelOf,
	type Responder,
} from "../../../__fixtures__/harness.ts"

/*
 * An `item` entity: a list, a create unique on `name`, a read with a documented 404, an update
 * sold behind the `pro` feature gate, and a delete that documents only `default`. A second entity,
 * `other`, owns traffic the item checks must leave alone. Error bodies carry a string `error`.
 */

export const ERROR = { properties: { error: { type: "string" } }, required: ["error"], type: "object" }
export const ITEM = {
	additionalProperties: false,
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}
/** A schema AJV refuses to compile: its pattern is not a regular expression. */
export const UNCOMPILABLE = { pattern: "(", type: "string" }

export const json = (schema: unknown) => ({ content: { "application/json": { schema } }, description: "-" })
const entity = (action: string, name = "item") => ({ "x-entity": { action, identity: "id", name } })

export interface ItemsOptions {
	/** The read's 404 body schema. */
	missing?: unknown
	/** The schema of the read's `{id}` path parameter. */
	id?: unknown
	/** The create's 201 body schema; `null` documents a 201 with no body. */
	created?: unknown
	/** The create's 409 body schema. */
	conflict?: unknown
	/** The gated update's responses, in place of a 200 and a documented 403. */
	update?: Record<string, unknown>
}

export function itemsDocument(options: ItemsOptions = {}): OpenApiDocument {
	const id = { in: "path", name: "id", required: true, schema: options.id ?? { type: "string" } }
	return {
		info: { title: "items", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items": {
				get: {
					operationId: "item.list",
					responses: { "200": json({ items: ITEM, type: "array" }) },
					...entity("list"),
				},
				post: {
					operationId: "item.create",
					requestBody: { content: { "application/json": { schema: ITEM } } },
					responses: {
						"201": options.created === null ? { description: "created" } : json(options.created ?? ITEM),
						"409": json(options.conflict ?? ERROR),
					},
					"x-unique": ["name"],
					...entity("create"),
				},
			},
			"/items/{id}": {
				delete: {
					operationId: "item.delete",
					parameters: [id],
					responses: { default: { description: "-" } },
					...entity("delete"),
				},
				get: {
					operationId: "item.read",
					parameters: [id],
					responses: { "200": json(ITEM), "404": json(options.missing ?? ERROR) },
					...entity("read"),
				},
				patch: {
					operationId: "item.update",
					parameters: [id],
					requestBody: { content: { "application/json": { schema: ITEM } } },
					responses: options.update ?? { "200": json(ITEM), "403": json(ERROR) },
					"x-feature-gate": "pro",
					...entity("update"),
				},
			},
			"/others": {
				get: { operationId: "other.list", responses: { "200": json({ type: "array" }) }, ...entity("list", "other") },
			},
		},
	} as unknown as OpenApiDocument
}

/** The item entity's operations, as `run()` would set them on the context. */
export function itemOperations(model: SpecModel): Partial<Listed> {
	const by = (id: string) => model.byOperationId.get(id)
	return {
		createOp: by("item.create"),
		deleteOp: by("item.delete"),
		readOp: by("item.read"),
		updateOp: by("item.update"),
		validator: new SchemaValidator(model.defs),
	}
}

/** An exchange of `operationId` as the transcript holds it, with any field `extra` sets. */
export function seen(operationId: string, answer: Answer, extra: Partial<Exchange> = {}): Exchange {
	const path = operationId === "item.create" ? "/items" : "/items/1"
	return { ...exchangeOf({ method: "GET", options: { as: { anonymous: true }, operationId }, path }, answer), ...extra }
}

/** An exchange that names no operation, as a request sent without one is recorded. */
export function unnamed(answer: Answer): Exchange {
	return exchange("GET", "/items/1", answer)
}

/** The body a documented feature-gate refusal carries. */
export const GATE_BODY = { error: "upgrade", vars: { feature: "pro", type: "feature_gate" } }

export interface Transcript {
	/** Bodies a read-back restores, by the exchange that lost its own. */
	stored?: Map<Exchange, unknown>
	respond?: Responder
	fields?: Partial<Listed>
}

/**
 * A context whose entity transcript is `exchanges`. Exchanges read back are logged in `hydrated`,
 * and get their body from `stored` when the transcript had moved it out of memory.
 */
export function overTranscript(model: SpecModel, exchanges: Exchange[], transcript: Transcript = {}) {
	const staged = contextFor(model, "item.list", {
		respond: transcript.respond ?? (() => undefined),
		fields: {
			...itemOperations(model),
			...transcript.fields,
		},
	})
	const hydrated: Exchange[] = []
	const stored = transcript.stored ?? new Map<Exchange, unknown>()
	const readBack = async (e: Exchange): Promise<Exchange> => {
		hydrated.push(e)
		return stored.has(e) ? { ...e, responseBody: stored.get(e) } : e
	}
	const client = { ...staged.ctx.client, exchangesForEntity: () => exchanges, hydrate: readBack }
	/* A spread drops the client's class methods from its type, not from the object. */
	return { ...staged, ctx: { ...staged.ctx, client: client as unknown as Client }, hydrated, model }
}

export function modelOfItems(options: ItemsOptions = {}): SpecModel {
	return modelOf(itemsDocument(options))
}
