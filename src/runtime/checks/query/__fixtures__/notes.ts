import type { QueryConventions } from "../../../../spec/conventions.ts"
import type { OperationModel, SpecModel } from "../../../../spec/graph.ts"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import type { CheckContext } from "../../core/context.ts"
import { contextFor, modelOf, op, type Responder, type Sent } from "../../__fixtures__/harness.ts"
import type { FindingCollector } from "../../../finding.ts"
import type { WriteContext } from "../../core/context.ts"

/*
 * One small entity, `note`, with every operation the shared check helpers reach for: a list that
 * pages by `limit` (at most 3) and `page`, filters, sorts and searches; a create with a request
 * body; a read, a PATCH update and a delete by `noteId`. Tests that need another paging shape
 * override the list's conventions with `withConventions` rather than writing a second document.
 */

const json = (schema: unknown, description = "ok") => ({ content: { "application/json": { schema } }, description })

export const NOTE = {
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		rank: { type: "integer" },
		tag: { type: ["string", "null"] },
	},
	type: "object",
} as const

const NOTE_INPUT = {
	properties: { name: { type: "string" }, rank: { type: "integer" } },
	required: ["name"],
	type: "object",
}

const ITEM_PARAM = [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }]

/** The notes document; `extra` merges further paths in. */
export function notesDoc(extra: Record<string, unknown> = {}): OpenApiDocument {
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					parameters: [
						{ in: "query", name: "limit", schema: { maximum: 3, type: "integer" } },
						{ in: "query", name: "page", schema: { type: "integer" } },
						{ in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "sort", schema: { type: "string" } },
						{ in: "query", name: "q", schema: { type: "string" } },
					],
					responses: { "200": json({ items: NOTE, type: "array" }) },
					"x-entity": { action: "list", name: "note" },
					"x-query": { filterable: ["name", "rank"], grammar: "postgrest", sortable: ["name", "rank"] },
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: NOTE_INPUT } } },
					responses: { "201": json(NOTE, "made") },
					"x-entity": { action: "create", name: "note" },
				},
			},
			"/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: ITEM_PARAM,
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", name: "note" },
				},
				get: {
					operationId: "note.read",
					parameters: ITEM_PARAM,
					responses: { "200": json(NOTE) },
					"x-entity": { action: "read", name: "note" },
				},
				patch: {
					operationId: "note.update",
					parameters: ITEM_PARAM,
					requestBody: { content: { "application/json": { schema: NOTE_INPUT } } },
					responses: { "200": json(NOTE) },
					"x-entity": { action: "update", name: "note" },
				},
			},
			...extra,
		},
	} as unknown as OpenApiDocument
}

/** The notes model, built once per call so a test may not leak state into another. */
export function notesModel(extra: Record<string, unknown> = {}): SpecModel {
	return modelOf(notesDoc(extra))
}

/** A context on the notes list, with every note operation wired in and the fake client answering. */
export function notesContext(
	respond: Responder = () => undefined,
	fields: Partial<CheckContext> = {},
	model: SpecModel = notesModel(),
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	return contextFor(model, "note.list", respond, {
		createOp: op(model, "note.create"),
		query: op(model, "note.list").query,
		deleteOp: op(model, "note.delete"),
		readOp: op(model, "note.read"),
		updateOp: op(model, "note.update"),
		...fields,
	})
}

/** `ctx` with its list operation's conventions replaced by `conventions` over the given base ones. */
export function withConventions<C extends CheckContext>(ctx: C, conventions: ConventionPatch): C {
	const merged = { ...ctx.listOp.conventions, ...conventions } as QueryConventions
	const listOp: OperationModel = { ...ctx.listOp, conventions: merged }
	return { ...ctx, listOp }
}

/** Conventions to lay over the list's own; an `undefined` takes a role away. */
export type ConventionPatch = { [K in keyof QueryConventions]?: QueryConventions[K] | undefined }

/** Conventions that name no query role at all: a list that cannot be paged, filtered or ordered. */
export const BARE: ConventionPatch = {
	cursor: undefined,
	filter: undefined,
	limit: undefined,
	offset: undefined,
	order: undefined,
	page: undefined,
	search: undefined,
	searchMode: undefined,
}
