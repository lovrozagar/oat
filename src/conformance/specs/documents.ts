/** Hostile spec fixtures about the document itself: empty, incomplete, recursive, invalid, unnamed. */

import type { SpecFixture } from "./types.ts"

/** A 200 JSON response with `schema`. */
export function okResponse(schema: unknown): Record<string, unknown> {
	return { "200": { content: { "application/json": { schema } }, description: "ok" } }
}

/** These fixtures, in the order the parser suite reports them. */
export function documentFixtures(): SpecFixture[] {
	return [empty(), noPathsKey(), recursiveRefs(), nullableWithoutType(), rootArrayResponse(), missingOperationIds()]
}

function empty(): SpecFixture {
	return {
		doc: { openapi: "3.1.0", paths: {} },
		expectEntities: 0,
		expectOperations: 0,
		name: "empty",
		why: "a document with no paths must produce an empty model, not an error",
	}
}

function noPathsKey(): SpecFixture {
	return {
		doc: { openapi: "3.1.0" },
		expectEntities: 0,
		expectOperations: 0,
		name: "no-paths-key",
		why: "the paths key is optional in the object model even though every real spec has it",
	}
}

function recursiveRefs(): SpecFixture {
	return {
		doc: {
			components: {
				schemas: {
					Node: {
						properties: {
							children: { items: { $ref: "#/components/schemas/Node" }, type: "array" },
							id: { type: "string" },
							parent: { $ref: "#/components/schemas/Node" },
						},
						type: "object",
					},
				},
			},
			openapi: "3.1.0",
			paths: {
				"/nodes": {
					get: {
						operationId: "node.list",
						responses: okResponse({
							properties: { nodes: { items: { $ref: "#/components/schemas/Node" }, type: "array" } },
							type: "object",
						}),
					},
				},
				"/nodes/{id}": {
					get: {
						operationId: "node.get",
						parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
						responses: okResponse({ $ref: "#/components/schemas/Node" }),
					},
				},
			},
		},
		expectOperations: 2,
		name: "recursive-refs",
		why: "self-referencing schemas must be shared, not expanded — expansion does not terminate",
	}
}

function nullableWithoutType(): SpecFixture {
	return {
		doc: {
			openapi: "3.0.3",
			paths: {
				"/things": {
					post: {
						operationId: "thing.create",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										additionalProperties: { nullable: true },
										nullable: true,
										type: "object",
									},
								},
							},
						},
						responses: okResponse({ properties: { id: { type: "string" } }, type: "object" }),
					},
				},
			},
		},
		expectOperations: 1,
		name: "nullable-without-type",
		why: "invalid JSON Schema that several generators still emit; must not break compilation",
	}
}

function rootArrayResponse(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/items": {
					get: { operationId: "item.list", responses: okResponse({ items: {}, type: "array" }) },
				},
			},
		},
		expectOperations: 1,
		name: "root-array-response",
		why: "a bare array response has no envelope, so the collection key is null rather than absent",
	}
}

function missingOperationIds(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/widgets": { get: { responses: okResponse({ type: "object" }) } },
				"/widgets/{id}": {
					get: {
						parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
						responses: okResponse({ type: "object" }),
					},
				},
			},
		},
		expectOperations: 2,
		name: "missing-operation-ids",
		why: "operationId is optional; oat must synthesise a stable identifier from method and path",
	}
}
