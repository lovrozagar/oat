import { describe, expect, it } from "vitest"
import type { OperationObject, SchemaObject } from "../spec/types.ts"
import { instanceErrors, SchemaValidator } from "./validate.ts"

const ITEM: SchemaObject = {
	properties: { id: { type: "integer" }, name: { type: "string" } },
	required: ["id"],
	type: "object",
}

function returning(code: string, mediaType: string, schema?: SchemaObject): OperationObject {
	return {
		responses: { [code]: { content: { [mediaType]: schema === undefined ? {} : { schema } }, description: "" } },
	}
}

describe("SchemaValidator", () => {
	it("passes a body that matches the documented schema, and fails one that does not", () => {
		const validator = new SchemaValidator()
		const op = returning("200", "application/json", ITEM)
		expect(validator.validate("get", op, { responseBody: { id: 1 }, status: 200 })).toEqual({ errors: [], ok: true })
		expect(validator.validate("get", op, { responseBody: { id: "x", name: 2 }, status: 200 })).toEqual({
			errors: ["/id must be integer", "/name must be string"],
			ok: false,
		})
		expect(validator.validate("get", op, { responseBody: [], status: 200 })).toEqual({
			errors: ["(root) must be object"],
			ok: false,
		})
	})

	it("falls back to the status class, then default, and reads only a JSON schema", () => {
		const validator = new SchemaValidator()
		expect(
			validator.validate("a", returning("2XX", "application/problem+json", ITEM), { responseBody: {}, status: 201 }).ok,
		).toBe(false)
		expect(
			validator.validate("b", returning("default", "application/json", ITEM), { responseBody: {}, status: 503 }).ok,
		).toBe(false)
		expect(validator.documents(returning("200", "text/plain", ITEM), 200)).toBe(false)
		expect(validator.documents(returning("200", "application/json"), 200)).toBe(false)
		expect(validator.documents({ responses: { "200": { description: "" } } }, 200)).toBe(false)
		expect(validator.documents({}, 200)).toBe(false)
		expect(validator.documents(returning("200", "application/json", ITEM), 200)).toBe(true)
		expect(validator.validate("c", {}, { responseBody: "anything", status: 200 })).toEqual({ errors: [], ok: true })
		expect(validator.validate("c", {}, { responseBody: "again", status: 200 })).toEqual({ errors: [], ok: true })
	})

	it("says a schema it cannot compile was not checked, every time it is asked", () => {
		const validator = new SchemaValidator()
		const op = returning("200", "application/json", { $ref: "#/nowhere" })
		const first = validator.validate("get", op, { responseBody: {}, status: 200 })
		expect(first.ok).toBe(true)
		expect(first.unchecked).toMatch(/resolve reference/)
		expect(validator.validate("get", op, { responseBody: {}, status: 200 })).toEqual(first)
	})

	it("reaches recursive definitions and lists at most twelve distinct errors", () => {
		const node: SchemaObject = { properties: { next: { $ref: "oat-defs#/$defs/Node" } }, type: "object" }
		const validator = new SchemaValidator({ Node: node })
		const op = returning("200", "application/json", { items: { $ref: "oat-defs#/$defs/Node" }, type: "array" })
		expect(validator.validate("list", op, { responseBody: [{ next: { next: {} } }], status: 200 }).ok).toBe(true)
		const result = validator.validate("list", op, { responseBody: Array.from({ length: 20 }, () => 1), status: 200 })
		expect(result.errors).toHaveLength(12)
		expect(result.errors[0]).toBe("/0 must be object")
	})
})

describe("instanceErrors", () => {
	it("lists what a value gets wrong, from the root or a path", () => {
		expect(instanceErrors(ITEM, { id: 1 })).toEqual([])
		expect(instanceErrors(ITEM, { id: "1" })).toEqual(["/id must be integer"])
		expect(instanceErrors(ITEM, 3)).toEqual(["(root) must be object"])
	})

	it("reaches the definitions it is given, and reuses one AJV for them", () => {
		const defs: Record<string, SchemaObject> = { Id: { type: "integer" } }
		expect(instanceErrors({ $ref: "oat-defs#/$defs/Id" }, "x", defs)).toEqual(["(root) must be integer"])
		expect(instanceErrors({ items: { $ref: "oat-defs#/$defs/Id" }, type: "array" }, [1], defs)).toEqual([])
	})

	it("reports a schema it cannot compile, once compiled or not", () => {
		const broken: SchemaObject = { $ref: "#/nowhere" }
		const [first] = instanceErrors(broken, {})
		expect(first).toMatch(/^schema cannot be compiled: .*resolve reference/)
		expect(instanceErrors(broken, {})).toEqual([first])
	})
})
