/** A small document whose operations declare, share and omit `x-rate-limit` budgets. */

import { buildModel } from "../../../spec/graph/build.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import { dereference } from "../../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"

const ok = { 200: { description: "ok" } }

const DOCUMENT = {
	info: { title: "rate limits", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/items": {
			get: { operationId: "items.list", responses: ok, "x-rate-limit": { category: "items.read", rps: 10 } },
			post: { operationId: "items.create", responses: ok, "x-rate-limit": { category: "items.write" } },
		},
		"/v1/items/{id}": {
			delete: { operationId: "items.delete", responses: ok },
			get: { operationId: "items.get", responses: ok, "x-rate-limit": { category: "items.read", rps: 4 } },
		},
	},
} as unknown as OpenApiDocument

export function rateLimitedModel(): SpecModel {
	return buildModel(dereference(DOCUMENT).doc)
}
