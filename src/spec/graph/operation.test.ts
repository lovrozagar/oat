import { describe, expect, it } from "vitest"
import { list, member, ok, query } from "../__fixtures__/documents.ts"
import { details, operationsOf } from "./__fixtures__/operations.ts"

/* The model's fields, in the order every operation carries them. */
const FIELDS = [
	"action",
	"async",
	"eventStream",
	"cleanup",
	"collection",
	"createdIdFrom",
	"recordPath",
	"cost",
	"featureGate",
	"unique",
	"destructive",
	"documentedStatuses",
	"statuses",
	"effects",
	"noEffects",
	"entity",
	"entitySource",
	"freshPrincipal",
	"generated",
	"hasRequestBody",
	"identity",
	"identitySource",
	"idempotent",
	"immutable",
	"invalidates",
	"rateLimit",
	"isMutation",
	"method",
	"operationId",
	"path",
	"pathParams",
	"query",
	"conventions",
	"queryParamNames",
	"requiredQuery",
	"idempotencyHeader",
	"rootParams",
	"route",
	"securitySchemes",
	"security",
	"softDelete",
	"invite",
	"wait",
	"tenantParam",
	"tenantSource",
]

const twoArrays = { properties: { a: list(member), b: list(member) }, type: "object" }

describe("modelOperation", () => {
	it("reads every fact the model keeps, in a fixed order", () => {
		const { operations } = operationsOf(
			{
				"/notes": {
					post: {
						operationId: "notes.create",
						parameters: [{ in: "header", name: "Idempotency-Key" }, query("tag", { enum: ["a"] }, { required: true })],
						requestBody: { content: { "application/json": { schema: member } } },
						responses: { "201": { content: { "application/json": { schema: member } }, description: "c" } },
						security: [{ jwt: [] }, { jwt: ["write"] }],
						"x-effects": [],
						"x-entity": { action: "create", name: "note" },
					},
				},
			},
			{ components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } } },
		)
		const [create] = operations
		expect(Object.keys(create ?? {})).toEqual(FIELDS)
		expect(create).toMatchObject({
			action: "create",
			documentedStatuses: [201],
			entity: "note",
			entitySource: "tag",
			hasRequestBody: true,
			identity: "id",
			identitySource: "schema",
			idempotencyHeader: "Idempotency-Key",
			isMutation: true,
			method: "POST",
			noEffects: true,
			query: null,
			queryParamNames: ["tag"],
			requiredQuery: { tag: "a" },
			route: "POST /notes",
			securitySchemes: ["jwt"],
		})
	})
})

describe("modelOperation collections", () => {
	it("finds the collection through allOf and a nullable array", () => {
		const { operations } = operationsOf({
			"/rows": {
				get: {
					operationId: "rows.list",
					responses: ok({
						allOf: [
							{ properties: { total: { type: "integer" } }, type: "object" },
							{ properties: { rows: { items: { allOf: [member] }, type: ["array", "null"] } }, type: "object" },
						],
					}),
				},
			},
		})
		const [rows] = operations
		expect(rows?.collection?.key).toBe("rows")
		expect(rows?.collection?.pagination.countKey).toBe("total")
		expect(rows?.conventions.envelope).toEqual({ total: "total" })
		expect(rows?.identity).toBe("id")
		expect(rows?.query).toBeNull()
		expect(rows?.noEffects).toBe(false)
	})

	it("asks which arrays are the rows only of a listing that does not say", () => {
		const { gaps } = operationsOf({
			"/a": { get: { operationId: "a", responses: ok(twoArrays) } },
			"/b": { get: { operationId: "b", responses: ok(twoArrays), "x-entity": { recordPath: "$.a" } } },
			"/c/{id}": { get: { operationId: "c", responses: ok(twoArrays) } },
			"/d": { post: { operationId: "d", responses: ok(twoArrays) } },
			"/": { get: { operationId: "root", responses: ok({ type: "object" }) } },
		})
		expect(gaps.gaps.filter((gap) => gap.tag === "x-entity.recordPath").map((gap) => gap.operationId)).toEqual(["a"])
		expect(details(gaps, "x-entity.recordPath")[0]).toBe(
			'the response holds several arrays of objects (a, b), so oat cannot tell which are the rows; name them with x-entity.recordPath (e.g. "$.a")',
		)
	})
})

describe("modelOperation x-query", () => {
	it("records the query capability's guess, then the filter grammar it gave up on, against x-query", () => {
		const { gaps, operations } = operationsOf({
			"/notes": { get: { operationId: "notes.list", parameters: [query("filter")], responses: ok(list(member)) } },
		})
		expect(operations[0]?.conventions.grammar).toBe("unrecognised")
		expect(operations[0]?.query?.source).toBe("heuristic")
		const found = details(gaps, "x-query")
		expect(found).toHaveLength(2)
		expect(found[0]).toMatch(/^endpoint accepts filter but does not declare which fields support them/)
		expect(found[1]).toMatch(/^parameter "filter" takes a filter expression whose grammar could not be recognised/)
	})

	it("reads the declared x-query grammar and the success response's Link header", () => {
		const { operations } = operationsOf({
			"/notes": {
				get: {
					operationId: "notes.list",
					parameters: [query("filter")],
					responses: ok(list(member), { headers: { Link: {} } }),
					"x-query": { grammar: "postgrest" },
				},
			},
		})
		expect(operations[0]?.conventions).toMatchObject({
			grammar: "postgrest",
			grammarDeclared: true,
			linkHeader: "Link",
		})
	})
})
