/** A route read by the OAS 3.2 QUERY method: a safe request that carries its question in a body. */

import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import type { Json, SpecContext } from "./types.ts"

/**
 * The payment methods the search reads, by component name: each branch is closed and requires its
 * tag, so a body whose fields fit one branch fits the other only when the tag is ignored.
 */
export function paymentSchemas(): Record<"Bank" | "Card", Json> {
	return {
		Card: {
			additionalProperties: false,
			properties: {
				kind: { type: "string" },
				last4: { maxLength: 4, minLength: 4, pattern: "^[0-9]{4}$", type: "string" },
			},
			required: ["kind", "last4"],
			type: "object",
		},
		Bank: {
			additionalProperties: false,
			properties: { account: { maxLength: 34, minLength: 1, type: "string" }, kind: { type: "string" } },
			required: ["kind", "account"],
			type: "object",
		},
	}
}

/* A card or a bank account, told apart by `kind`: the union of component refs a discriminator names. */
function paymentMethod(): Json {
	return {
		discriminator: {
			mapping: { bank: "#/components/schemas/Bank", card: "#/components/schemas/Card" },
			propertyName: "kind",
		},
		oneOf: [{ $ref: "#/components/schemas/Card" }, { $ref: "#/components/schemas/Bank" }],
	}
}

/** `QUERY /v1/search`, public: the payment method the body names, as the search reads it. */
export function searchPaths(ctx: SpecContext): Json {
	return {
		"/v1/search": {
			query: {
				operationId: "search.query",
				requestBody: { content: { "application/json": { schema: paymentMethod() } }, required: true },
				responses: {
					[ok(ctx, 200)]: jsonResponse("The payment method the body names", paymentMethod()),
					...errorResponses(ctx, [400, 415]),
				},
				security: [],
				summary: "Find a payment method",
				tags: ["Search"],
			},
		},
	}
}
