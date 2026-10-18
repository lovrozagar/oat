import { describe, expect, it } from "vitest"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import { accountsDoc } from "./__fixtures__/accounts.ts"
import { bodyFor, identityOf, parentList, recordsOf } from "./lists.ts"

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const list = (operationId: string, schema: unknown) => ({
	get: { operationId, responses: { "200": { description: "ok", ...json(schema) } } },
})

/* Lists of every shape a destructive route's parent may answer with. */
const model = modelOf(
	accountsDoc({
		"/v1/bare": list("bare.list", {
			items: { properties: { slug: { type: "string" } }, type: "object" },
			type: "array",
		}),
		"/v1/named": list("named.list", {
			items: { properties: { key_id: { type: "string" } }, type: "object" },
			type: "array",
		}),
		"/v1/opaque": { get: { operationId: "opaque.list", responses: { "200": { description: "ok" } } } },
	}),
)
const op = (id: string) => {
	const found = model.byOperationId.get(id)
	if (found === undefined) throw new Error(`no ${id}`)
	return found
}

describe("recordsOf", () => {
	it("reads the rows under the list's key, or the body itself", () => {
		expect(recordsOf({ keys: [{ id: "k1" }, null, [], "x"] }, op("keys.list"), model)).toEqual([{ id: "k1" }])
		expect(recordsOf([{ slug: "s" }], op("bare.list"), model)).toEqual([{ slug: "s" }])
		expect(recordsOf([{ a: 1 }], op("opaque.list"), model)).toEqual([{ a: 1 }])
		expect(recordsOf({ keys: "none" }, op("keys.list"), model)).toEqual([])
		expect(recordsOf(null, op("keys.list"), model)).toEqual([])
		expect(recordsOf("text", op("bare.list"), model)).toEqual([])
	})
})

describe("identityOf", () => {
	it("is the param when rows carry it, else the derived identity, else `id`", () => {
		expect(identityOf(op("named.list"), model, "key_id")).toBe("key_id")
		expect(identityOf(op("keys.list"), model, "key_id")).toBe("id")
		expect(identityOf(op("bare.list"), model, "key_id")).toBe("slug")
		expect(identityOf(op("opaque.list"), model, "key_id")).toBe("id")
		expect(identityOf(op("opaque.list"), model, "member")).toBe("id")
	})
})

describe("parentList", () => {
	it("is the GET one level up", () => {
		expect(parentList(model, op("keys.delete"))?.operationId).toBe("keys.list")
		expect(parentList(model, op("auth.logout"))).toBeUndefined()
	})
})

describe("bodyFor", () => {
	it("overlays what the signup knows on the generated body", () => {
		const schema = { properties: { email: {}, name: {} }, type: "object" }
		expect(bodyFor(schema, { email: "e@x", other: 1 }, { name: "g" })).toEqual({ email: "e@x", name: "g" })
		expect(bodyFor({ type: "object" }, { email: "e@x" }, { name: "g" })).toEqual({ name: "g" })
		expect(bodyFor({ properties: null }, { email: "e@x" }, {})).toEqual({})
		expect(bodyFor({ properties: "x" }, { email: "e@x" }, {})).toEqual({})
		expect(bodyFor(null, { email: "e@x" }, { name: "g" })).toBeUndefined()
	})
})
