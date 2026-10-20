import { fileURLToPath } from "node:url"
import type { RequestOptions } from "../../../../../client/types.ts"
import type { UploadContext } from "../../../../upload.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"

/*
 * A small API for the effects and async checks: widgets (a flat collection with an action), boards
 * and their cards (a parent created by an action, and a nested child list), jobs (a create with no
 * list, polled by id), events (a paged list), and an inbox (no entity at all). Each test adds the
 * one operation it needs with `withOperation`.
 */

const idParam = (name: string): Record<string, unknown> => ({
	in: "path",
	name,
	required: true,
	schema: { type: "string" },
})

const record = {
	properties: { id: { readOnly: true, type: "string" }, name: { type: "string" } },
	required: ["name"],
	type: "object",
}

const json = (schema: unknown): Record<string, unknown> => ({ content: { "application/json": { schema } } })

const ok = (schema: unknown = record): Record<string, unknown> => ({ "200": { description: "ok", ...json(schema) } })

const listOf = (operationId: string, parameters: unknown[] = []): Record<string, unknown> => ({
	operationId,
	parameters,
	responses: ok({ items: record, type: "array" }),
})

const createOf = (operationId: string): Record<string, unknown> => ({
	operationId,
	requestBody: json(record),
	responses: ok(),
})

/** The base document; every call returns a fresh copy a test may change. */
export function baseDocument(): OpenApiDocument {
	const paging = [
		{ in: "query", name: "page", schema: { type: "integer" } },
		{ in: "query", name: "limit", schema: { type: "integer" } },
	]
	return {
		info: { title: "effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/boards": { get: listOf("listBoards"), post: createOf("createBoard") },
			"/boards/{board_id}": {
				delete: { operationId: "deleteBoard", responses: { "204": { description: "ok" } } },
				get: { operationId: "getBoard", responses: ok() },
				parameters: [idParam("board_id")],
			},
			"/boards/{board_id}/cards": {
				get: listOf("listCards"),
				parameters: [idParam("board_id")],
				post: createOf("createCard"),
			},
			"/boards/{board_id}/cards/{card_id}": {
				get: { operationId: "getCard", responses: ok() },
				parameters: [idParam("board_id"), idParam("card_id")],
			},
			"/events": { get: listOf("listEvents", paging) },
			"/inbox": { get: { operationId: "getInbox", responses: ok({ type: "object" }) } },
			"/jobs/{id}": { get: { operationId: "getJob", responses: ok() }, parameters: [idParam("id")] },
			"/widgets": { get: listOf("listWidgets"), post: createOf("createWidget") },
			"/widgets/{id}": {
				delete: { operationId: "deleteWidget", responses: { "204": { description: "ok" } } },
				get: { operationId: "getWidget", responses: ok() },
				parameters: [idParam("id")],
			},
		},
	} as unknown as OpenApiDocument
}

/** Adds `operation` (with its operationId and any x- tags) at `route`, written `method path`: "post /jobs". */
export function withOperation(
	doc: OpenApiDocument,
	route: string,
	operation: Record<string, unknown>,
): OpenApiDocument {
	const [method, path] = route.split(" ") as [string, string]
	const paths = doc.paths as Record<string, Record<string, unknown>>
	const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => idParam(m[1] ?? ""))
	paths[path] = { ...paths[path], [method]: { responses: ok({ type: "object" }), ...operation } }
	if (params.length > 0 && paths[path]?.parameters === undefined) paths[path] = { ...paths[path], parameters: params }
	return doc
}

/** An operation that sends the shared record as its JSON body. */
export const withBody = json(record)

/** Handles one route: an answer, or `undefined` for a 404. */
export type Handler = (options: Omit<RequestOptions, "as">) => Answer | undefined

/** A responder from a table of `"METHOD /path"` handlers; anything else is a 404. */
export function routes(table: Record<string, Handler>): Responder {
	return (method, path, options) => table[`${method} ${path}`]?.(options)
}

/** The 403 body a documented `x-feature-gate` denial carries. */
export const featureGateDenial: Answer = {
	body: { vars: { feature: "pro", type: "feature_gate" } },
	status: 403,
}

/** Uploads that invoke `operationId` once per `uploads.each` file: this one, `documents.ts`. */
export function eachFixture(operationId: string): UploadContext {
	return {
		configDir: fileURLToPath(new URL(".", import.meta.url)),
		seed: 1,
		uploads: { each: { [operationId]: ["documents.ts"] } },
	}
}
