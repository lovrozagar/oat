/** A route whose query is written in two OAS styles: a deepObject range and pipe-delimited ids. */

import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import type { Json, SpecContext } from "./types.ts"

const RANGE: Json = {
	additionalProperties: false,
	properties: { max: { type: "integer" }, min: { type: "integer" } },
	required: ["min", "max"],
	type: "object",
}

const IDS: Json = { items: { pattern: "^[a-z0-9_]+$", type: "string" }, minItems: 1, type: "array" }

/**
 * `GET /v1/styles`, public. The server answers 200 only when both values arrive in their declared
 * style, so a client that writes either in another style is refused, and its contract call fails.
 */
export function stylePaths(ctx: SpecContext): Json {
	return {
		"/v1/styles": {
			get: {
				operationId: "styles.read",
				parameters: [
					{
						example: { max: 5, min: 1 },
						in: "query",
						name: "range",
						required: true,
						schema: RANGE,
						style: "deepObject",
					},
					{
						example: ["a", "b"],
						explode: false,
						in: "query",
						name: "ids",
						required: true,
						schema: IDS,
						style: "pipeDelimited",
					},
				],
				responses: {
					[ok(ctx, 200)]: jsonResponse("The range and ids as the server parsed them", {
						additionalProperties: false,
						properties: { ids: IDS, range: RANGE },
						required: ["range", "ids"],
						type: "object",
					}),
					...errorResponses(ctx, [400]),
				},
				security: [],
				summary: "Echo styled query parameters",
				tags: ["Styles"],
			},
		},
	}
}
