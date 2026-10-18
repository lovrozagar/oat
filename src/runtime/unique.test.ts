import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../spec/types.ts"
import { modelOf, op } from "./checks/__fixtures__/harness.ts"
import {
	bodyPropertyNames,
	collisionCreateBody,
	collisionUpdatePatch,
	idempotencyHeaderRequired,
	isIdempotencyHeaderName,
	isUniqueConflictResponse,
	probeableUniqueSets,
	uniqueProbeHeaders,
	uniqueTupleCollides,
	uniquifyProbeBody,
} from "./unique.ts"

const user = {
	properties: {
		email: { format: "email", type: "string" },
		id: { readOnly: true, type: "string", "x-generated": true },
		slug: { type: "string" },
	},
	type: "object",
}

const ok = { "201": { description: "ok" } }

const doc = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/bare": { post: { operationId: "bare.create", responses: ok, "x-unique": [["email"]] } },
		"/flag": {
			post: {
				operationId: "flag.create",
				parameters: [{ in: "header", name: "Idempotency-Key", schema: { type: "string" } }],
				requestBody: { content: { "application/json": { schema: true } } },
				responses: ok,
			},
		},
		"/loose": {
			post: {
				operationId: "loose.create",
				requestBody: { content: { "application/json": { schema: { properties: null, type: "object" } } } },
				responses: ok,
			},
		},
		"/users": {
			post: {
				operationId: "users.create",
				parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }],
				requestBody: { content: { "application/json": { schema: user } } },
				responses: ok,
				"x-unique": [["email"], ["slug", "org"], ["id"]],
			},
		},
	},
} as unknown as OpenApiDocument

const model = modelOf(doc)

describe("a unique conflict", () => {
	it("is a 409 on an operation that declares a unique set", () => {
		expect(isUniqueConflictResponse({ unique: [["email"]] }, 409)).toBe(true)
		expect(isUniqueConflictResponse({ unique: [["email"]] }, 400)).toBe(false)
		expect(isUniqueConflictResponse({ unique: [] }, 409)).toBe(false)
		expect(isUniqueConflictResponse({ unique: null }, 409)).toBe(false)
	})
})

describe("idempotency headers", () => {
	it("are recognized by name in every spelling the document uses", () => {
		for (const name of [
			"Idempotency-Key",
			"x-idempotency-key",
			"Idempotence_Key",
			"idempotency",
			"X-Idempotency Key",
		]) {
			expect(isIdempotencyHeaderName(name)).toBe(true)
		}
		expect(isIdempotencyHeaderName("authorization")).toBe(false)
	})

	it("a probe sends auth only, and a fresh key where the document requires one", () => {
		const auth = { authorization: "Bearer t", "Idempotency-Key": "old" }
		expect(uniqueProbeHeaders(auth, "Idempotency-Key", false, "new")).toEqual({ authorization: "Bearer t" })
		expect(uniqueProbeHeaders(auth, "Idempotency-Key", true, "new")).toEqual({
			authorization: "Bearer t",
			"Idempotency-Key": "new",
		})
		expect(uniqueProbeHeaders(auth, null, true, "new")).toEqual({ authorization: "Bearer t" })
		expect(uniqueProbeHeaders(auth, "", true, "new")).toEqual({ authorization: "Bearer t" })
	})

	it("is required only where the document marks the header parameter required", () => {
		expect(idempotencyHeaderRequired(op(model, "users.create"), model)).toBe(true)
		expect(idempotencyHeaderRequired(op(model, "flag.create"), model)).toBe(false)
		expect(idempotencyHeaderRequired(op(model, "bare.create"), model)).toBe(false)
		const unknown = { ...op(model, "flag.create"), operationId: "ghost" }
		expect(idempotencyHeaderRequired(unknown, model)).toBe(false)
	})
})

describe("body property names", () => {
	it("are the request schema's properties, and none where there is no object schema", () => {
		expect([...bodyPropertyNames(op(model, "users.create"), model)]).toEqual(["email", "id", "slug"])
		expect(bodyPropertyNames(op(model, "bare.create"), model).size).toBe(0)
		expect(bodyPropertyNames(op(model, "flag.create"), model).size).toBe(0)
		expect(bodyPropertyNames(op(model, "loose.create"), model).size).toBe(0)
		expect(bodyPropertyNames({ ...op(model, "users.create"), operationId: "ghost" }, model).size).toBe(0)
	})
})

describe("probeable unique sets", () => {
	const users = op(model, "users.create")

	it("are the sets with a body column the server does not generate", () => {
		expect(probeableUniqueSets(users, model, "create")).toEqual([["email"], ["slug", "org"]])
		expect(probeableUniqueSets({ ...users, unique: null }, model, "create")).toEqual([])
	})

	it("skip an update set whose columns are all immutable", () => {
		const immutable = { ...users, immutable: ["slug", "org"] }
		expect(probeableUniqueSets(immutable, model, "update", [["slug", "org"], ["email"], []])).toEqual([["email"]])
	})
})

describe("unique tuples", () => {
	it("collide when an existing row holds the body's values on a set", () => {
		const rows = [{ email: "a@x.test", slug: "s" }]
		expect(uniqueTupleCollides({ email: "a@x.test" }, [["email"]], rows)).toBe(true)
		expect(uniqueTupleCollides({ email: "b@x.test" }, [["email"]], rows)).toBe(false)
		expect(uniqueTupleCollides({ title: "t" }, [["email"]], rows)).toBe(false)
	})
})

describe("uniquifying a probe body", () => {
	const schema = user as Record<string, unknown>

	it("draws a new value from each unique column's schema", () => {
		const body = { email: "a@x.test", slug: "s", title: "t" }
		const out = uniquifyProbeBody(body, [["email"], ["missing"]], schema, "tok")
		expect(out.email).not.toBe("a@x.test")
		expect(out.email).toMatch(/@/)
		expect(out).toMatchObject({ slug: "s", title: "t" })
		expect(out).not.toHaveProperty("missing")
	})

	it("leaves a body without unique sets as it was, as a copy", () => {
		const body = { email: "a@x.test" }
		const out = uniquifyProbeBody(body, [], schema, "tok")
		expect(out).toEqual(body)
		expect(out).not.toBe(body)
	})

	it("keeps a value where the schema admits nothing new, or names no such column", () => {
		const narrow = { properties: { fixed: { const: "only" }, never: { enum: [] }, plain: null }, type: "object" }
		const body = { fixed: "only", never: 1, other: 2, plain: 3 }
		expect(uniquifyProbeBody(body, [["fixed", "never", "other", "plain"]], narrow, "tok")).toEqual(body)
		expect(uniquifyProbeBody(body, [["fixed"]], null, "tok")).toEqual(body)
		expect(uniquifyProbeBody(body, [["fixed"]], { properties: "x" }, "tok")).toEqual(body)
	})
})

describe("a collision create body", () => {
	const write = { bodyColumns: new Set(["email", "slug"]), generated: ["id"], scope: { org: "o1" } }

	it("overlays a known row's values on the set's body columns", () => {
		const known = { email: "k@x.test", slug: "k" }
		expect(collisionCreateBody({ email: "b", slug: "b" }, known, { ...write, set: ["slug", "org", "id"] })).toEqual({
			email: "b",
			slug: "k",
		})
	})

	it("takes a value from scope, and is null when a column has none or nothing is written", () => {
		const scoped = { ...write, bodyColumns: new Set(["org"]), set: ["org"] }
		expect(collisionCreateBody({}, {}, scoped)).toEqual({ org: "o1" })
		expect(collisionCreateBody({}, {}, { ...write, set: ["email"] })).toBeNull()
		expect(collisionCreateBody({}, { id: "1" }, { ...write, set: ["id"] })).toBeNull()
	})
})

describe("a collision update patch", () => {
	const write = {
		bodyColumns: new Set(["email", "slug"]),
		generated: ["id"],
		immutable: ["slug"],
		scope: { org: "o1" },
	}

	it("writes the source's values on the set's writable columns", () => {
		const source = { email: "s@x.test", slug: "same" }
		const target = { email: "t@x.test", slug: "same" }
		expect(collisionUpdatePatch(source, target, { ...write, set: ["email", "slug", "org"] })).toEqual({
			email: "s@x.test",
		})
	})

	it("is null when a value is missing, an unwritable column differs, or nothing is written", () => {
		const source = { email: "s@x.test", slug: "a" }
		expect(collisionUpdatePatch(source, {}, { ...write, set: ["title"] })).toBeNull()
		expect(collisionUpdatePatch(source, { slug: "b" }, { ...write, set: ["email", "slug"] })).toBeNull()
		expect(collisionUpdatePatch(source, { slug: "a" }, { ...write, set: ["slug"] })).toBeNull()
	})
})
