import type { Exchange } from "../../../../exchange.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import type { CheckContext } from "../../../core/context.ts"
import { type Answer, contextFor, modelOf } from "../../../__fixtures__/harness.ts"

/*
 * An `item` entity with a list and a create: the create's request schema, media type and
 * responses are what each validation check reads, so a test states only those.
 */

const listed = {
	content: { "application/json": { schema: { items: { type: "object" }, type: "array" } } },
	description: "ok",
}

/** The document, with `create` merged over a JSON create whose request body is `schema`. */
export function itemsDocument(
	schema: Record<string, unknown> | null,
	create: Record<string, unknown> = {},
	mediaType = "application/json",
): OpenApiDocument {
	return {
		info: { title: "items", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items": {
				get: {
					operationId: "item.list",
					responses: { "200": listed },
					"x-entity": { action: "list", identity: "id", name: "item" },
				},
				post: {
					operationId: "item.create",
					...(schema === null ? {} : { requestBody: { content: { [mediaType]: { schema } } } }),
					responses: { "201": { description: "made" }, "422": { description: "refused" } },
					"x-entity": { action: "create", identity: "id", name: "item" },
					...create,
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** A context over `doc` whose create is the document's, answering every request with `answer`. */
export function stage(doc: OpenApiDocument, answer: Answer, fields: Partial<CheckContext> = {}) {
	const model = modelOf(doc)
	return contextFor(model, "item.list", {
		respond: () => answer,
		fields: { createOp: model.byOperationId.get("item.create"), ...fields },
	})
}

/** The 403 a documented feature gate answers with. */
export const GATED: Answer = { body: { vars: { feature: "pro", type: "feature_gate" } }, status: 403 }

/** The evidence a finding cites, as method, path and status. */
export function cited(evidence: Exchange[]): string[] {
	return evidence.map((e) => `${e.method} ${new URL(e.url).pathname} ${e.status}`)
}
