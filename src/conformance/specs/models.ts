/** Hostile spec fixtures about what oat models from a document: envelopes, names, composition, references, query roles. */

import type { SpecFixture } from "./types.ts"
import { okResponse } from "./documents.ts"

/** These fixtures, in the order the parser suite reports them. */
export function modelFixtures(): SpecFixture[] {
	return [
		multipleArraysInEnvelope(),
		irregularPlurals(),
		allofComposedResponse(),
		deeplyNestedPath(),
		externalRef(),
		danglingRef(),
		scopesNotAList(),
		queryRolesByAlias(),
		paginationOnlyIsNotQuery(),
	]
}

function multipleArraysInEnvelope(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/reports": {
					get: {
						operationId: "report.list",
						responses: okResponse({
							properties: {
								errors: { items: { type: "string" }, type: "array" },
								reports: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
								warnings: { items: { type: "string" }, type: "array" },
							},
							type: "object",
						}),
					},
				},
			},
		},
		expectOperations: 1,
		name: "multiple-arrays-in-envelope",
		why: "the collection is the payload array, not the sidecar errors and warnings arrays",
	}
}

function irregularPlurals(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/analyses": {
					get: { operationId: "analysis.list", responses: okResponse({ type: "object" }) },
				},
				"/statuses": {
					get: { operationId: "status.list", responses: okResponse({ type: "object" }) },
				},
				"/people": {
					get: { operationId: "person.list", responses: okResponse({ type: "object" }) },
				},
				"/campuses": {
					get: { operationId: "campus.list", responses: okResponse({ type: "object" }) },
				},
				"/inboxes": {
					get: { operationId: "inbox.list", responses: okResponse({ type: "object" }) },
				},
			},
		},
		expectOperations: 5,
		name: "irregular-plurals",
		why: "status must not become statu, campuses must not become campuse",
	}
}

function allofComposedResponse(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/things": {
					get: {
						operationId: "thing.list",
						responses: okResponse({
							allOf: [
								{ properties: { count: { type: "integer" } }, type: "object" },
								{
									properties: {
										things: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
									},
									type: "object",
								},
							],
						}),
					},
				},
			},
		},
		expectOperations: 1,
		name: "allof-composed-response",
		why: "composition hides the collection behind allOf; oat should degrade, never throw",
	}
}

function deeplyNestedPath(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/a/{x}/b/{y}/c/{z}/d": {
					get: {
						operationId: "deep.list",
						parameters: ["x", "y", "z"].map((name) => ({
							in: "path",
							name,
							required: true,
							schema: { type: "string" },
						})),
						responses: okResponse({ type: "object" }),
					},
				},
			},
		},
		expectOperations: 1,
		name: "deeply-nested-path",
		why: "three levels of ancestry must resolve without confusing which parameter owns what",
	}
}

function externalRef(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/external": {
					get: {
						operationId: "external.get",
						responses: okResponse({ $ref: "https://example.com/schemas/thing.json" }),
					},
				},
			},
		},
		expectOperations: 1,
		name: "external-ref",
		why: "external refs must be reported, never fetched — a test tool should not follow URLs",
	}
}

function danglingRef(): SpecFixture {
	return {
		doc: {
			components: {
				schemas: { Payment: { properties: { fee: { $ref: "#/components/schemas/Fee" } }, type: "object" } },
			},
			openapi: "3.0.0",
			paths: {
				"/payments": {
					get: { operationId: "payment.list", responses: okResponse({ $ref: "#/components/schemas/Payment" }) },
				},
				"/refunds": {
					get: {
						operationId: "refund.list",
						parameters: [{ $ref: "#/components/parameters/Missing" }],
						responses: okResponse({ type: "object" }),
					},
				},
			},
		},
		expectOperations: 2,
		name: "dangling-ref",
		why: "Square's published spec refers to schemas it never defines; the rest of the document must still model",
	}
}

function scopesNotAList(): SpecFixture {
	return {
		doc: {
			components: { securitySchemes: { oauth2: { flows: {}, type: "oauth2" } } },
			openapi: "3.0.0",
			paths: {
				"/oauth2/revoke": {
					post: { operationId: "RevokeToken", responses: okResponse({ type: "object" }), security: [{ oauth2: null }] },
				},
			},
		},
		expectOperations: 1,
		name: "scopes-not-a-list",
		why: "Square's published spec gives RevokeToken's oauth2 requirement null for its scopes; the operation must still model",
	}
}

function queryRolesByAlias(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/articles": {
					get: {
						operationId: "article.list",
						parameters: [
							{ in: "query", name: "sort", schema: { type: "string" } },
							{ in: "query", name: "fields", schema: { type: "string" } },
							{ in: "query", name: "q", schema: { type: "string" } },
							{
								in: "query",
								name: "per_page",
								schema: { default: 10, maximum: 50, minimum: 1, type: "integer" },
							},
						],
						responses: okResponse({
							properties: {
								articles: {
									items: {
										properties: { id: { type: "string" }, title: { type: "string" } },
										type: "object",
									},
									type: "array",
								},
							},
							type: "object",
						}),
					},
				},
			},
		},
		expectEntities: 1,
		expectOperations: 1,
		name: "query-roles-by-alias",
		why: "untagged x-query must recognize sort/fields/q/per_page, not only filter/order/select",
	}
}

function paginationOnlyIsNotQuery(): SpecFixture {
	return {
		doc: {
			openapi: "3.1.0",
			paths: {
				"/articles": {
					get: {
						operationId: "article.list",
						parameters: [
							{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
							{ in: "query", name: "limit", schema: { default: 20, maximum: 100, type: "integer" } },
							{ in: "query", name: "status", schema: { type: "string" } },
						],
						responses: okResponse({
							properties: {
								articles: {
									items: { properties: { id: { type: "string" } }, type: "object" },
									type: "array",
								},
							},
							type: "object",
						}),
					},
				},
			},
		},
		expectEntities: 1,
		expectOperations: 1,
		name: "pagination-only-is-not-query",
		why: "page/limit/status is not a query grammar; the heuristic must not invent one",
	}
}
