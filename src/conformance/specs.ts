/**
 * Hostile spec fixtures.
 *
 * Every one of these is a shape found in a real published OpenAPI document. The bar is not that
 * oat models them well — several are genuinely untestable — but that it never throws, never
 * hangs, and says plainly what it could not do. Prior art in this space died on exactly this
 * class: one `nullable` without a `type` made the validator refuse to compile and took the whole
 * run with it.
 *
 * Vendored rather than downloaded so the check stays offline and deterministic.
 */

export interface SpecFixture {
	name: string
	why: string
	doc: Record<string, unknown>
	/** Operations oat should find. Undefined means "no expectation, just do not crash". */
	expectOperations?: number
	expectEntities?: number
}

const okResponse = (schema: unknown) => ({
	"200": { content: { "application/json": { schema } }, description: "ok" },
})

export const SPEC_FIXTURES: SpecFixture[] = [
	{
		doc: { openapi: "3.1.0", paths: {} },
		expectEntities: 0,
		expectOperations: 0,
		name: "empty",
		why: "a document with no paths must produce an empty model, not an error",
	},
	{
		doc: { openapi: "3.1.0" },
		expectEntities: 0,
		expectOperations: 0,
		name: "no-paths-key",
		why: "the paths key is optional in the object model even though every real spec has it",
	},
	{
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
	},
	{
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
	},
	{
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
	},
	{
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
	},
	{
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
	},
	{
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
			},
		},
		expectOperations: 3,
		name: "irregular-plurals",
		why: "status must not become statu, analyses must not become analyse",
	},
	{
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
	},
	{
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
	},
	{
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
	},
]
