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
	"consistency",
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
	"unsendable",
	"method",
	"operationId",
	"path",
	"pathParams",
	"privileged",
	"privilegedRequired",
	"query",
	"conventions",
	"queryParamNames",
	"requiredQuery",
	"requiredHeaders",
	"requiredCookies",
	"paramStyles",
	"idempotencyHeader",
	"etag",
	"ifMatch",
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

describe("modelOperation methods", () => {
	it("reads QUERY as a read, and flags TRACE as never sent with the reason", () => {
		const { operations } = operationsOf({
			"/search": { query: { operationId: "search" }, trace: { operationId: "echo" } },
		})
		const [echo, search] = operations
		expect(search).toMatchObject({ isMutation: false, method: "QUERY", unsendable: null })
		expect(echo).toMatchObject({ isMutation: false, method: "TRACE" })
		expect(echo?.unsendable).toMatch(/^fetch refuses TRACE/)
	})
})

describe("modelOperation preconditions", () => {
	it("reads an ETag a success response declares and the If-Match header the operation takes, by any case", () => {
		const { operations } = operationsOf({
			"/notes/{id}": {
				get: { operationId: "notes.get", responses: { "200": { description: "ok", headers: { etag: {} } } } },
				patch: {
					operationId: "notes.update",
					parameters: [{ in: "header", name: "if-match", schema: { type: "string" } }],
					responses: { "200": { description: "ok" }, "412": { description: "stale", headers: { ETag: {} } } },
				},
				put: {
					operationId: "notes.replace",
					parameters: [{ in: "query", name: "If-Match" }],
					responses: { "200": { description: "ok", headers: { "X-ETag": {} } } },
				},
			},
			"/tags/{id}": {
				get: { operationId: "tags.get", responses: { "2XX": { description: "ok", headers: { ETag: {} } } } },
				patch: { operationId: "tags.update", responses: { default: { description: "any", headers: { ETag: {} } } } },
			},
		})
		const byId = new Map(operations.map((operation) => [operation.operationId, operation]))
		expect(byId.get("notes.get")).toMatchObject({ etag: true, ifMatch: null })
		/* A 412's ETag is not a success's, and only a header parameter is a precondition. */
		expect(byId.get("notes.update")).toMatchObject({ etag: false, ifMatch: "if-match" })
		expect(byId.get("notes.replace")).toMatchObject({ etag: false, ifMatch: null })
		/* A success range is a success response; `default` is not. */
		expect(byId.get("tags.get")?.etag).toBe(true)
		expect(byId.get("tags.update")?.etag).toBe(false)
	})
})

describe("modelOperation privileged", () => {
	it("names the request body properties marked x-privileged, and reports a misplaced marker", () => {
		const body = {
			properties: { name: { type: "string" }, verified: { type: "boolean", "x-privileged": true } },
			type: "object",
		}
		const { gaps, operations } = operationsOf({
			"/tables/{id}": {
				patch: {
					operationId: "table.update",
					requestBody: { content: { "application/json": { schema: body } } },
					responses: { "200": { description: "ok" } },
					"x-privileged": true,
				},
			},
		})
		expect(operations[0]?.privileged).toEqual(["verified"])
		expect(details(gaps, "x-privileged")).toEqual([
			"x-privileged belongs on a request body property, not on the operation; oat cannot use it",
		])
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
		expect(operations[0]?.conventions.grammar).toBe("unrecognized")
		expect(operations[0]?.query?.source).toBe("heuristic")
		const found = details(gaps, "x-query")
		expect(found).toHaveLength(2)
		expect(found[0]).toMatch(/^endpoint accepts filter but does not declare which fields support them/)
		expect(found[1]).toMatch(/^parameter "filter" takes a filter expression whose grammar could not be recognized/)
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

describe("modelOperation and a malformed x-entity", () => {
	it("reports what is wrong with the tag, and uses what of it is sound or reads the path instead", () => {
		const cases = [
			{ entity: "note", tag: { action: "list" }, wrong: /^x-entity needs "name"/ },
			{ entity: "note", tag: { action: "browse", name: "memo" }, wrong: /^x-entity "action" must be one of/ },
			{ entity: "memo", tag: { action: "list", identity: 7, name: "memo" }, wrong: /^x-entity "identity" must be/ },
		]
		for (const { entity, tag, wrong } of cases) {
			const { gaps, operations } = operationsOf({ "/notes": { get: { ...list("note"), "x-entity": tag } } })
			expect(gaps.gaps.filter((gap) => gap.tag === "x-entity").map((gap) => gap.detail)).toEqual([
				expect.stringMatching(wrong),
			])
			expect(operations[0]?.entity).toBe(entity)
		}
	})
})

describe("modelOperation and a scope list that is not an array", () => {
	it("models the operation with no scopes and records a security gap naming the scheme", () => {
		const revoke = { operationId: "RevokeToken", responses: {}, security: [{ oauth2: null }] }
		const { gaps, operations } = operationsOf({ "/oauth2/revoke": { post: revoke } })
		expect(operations.map((op) => [op.operationId, op.unsendable, op.security.alternatives])).toEqual([
			["RevokeToken", null, [[{ scheme: "oauth2", scopes: [] }]]],
		])
		expect(gaps.gaps.filter((gap) => gap.tag === "security")).toEqual([
			{
				detail:
					'security requirement "oauth2" gives its scopes as something other than a list; oat reads it as no scopes',
				operationId: "RevokeToken",
				tag: "security",
			},
		])
	})
})
