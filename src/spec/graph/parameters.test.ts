import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import type { OperationObject, ParameterObject } from "../types.ts"
import { idempotencyHeader, readRequiredQuery, successResponseHeaders } from "./parameters.ts"

const required = (name: string, schema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	query(name, schema, { required: true, ...extra })

describe("readRequiredQuery", () => {
	it("takes each required query parameter's declared value, in order of preference", () => {
		const parameters: ParameterObject[] = [
			required("a", { example: "schema", type: "string" }, { example: "param" }),
			required("b", { type: "integer" }, { examples: { none: null, empty: {}, one: { value: 7 } } }),
			required("c", { example: "schema", examples: ["listed"] }),
			required("d", { const: "fixed", example: "schema" }),
			required("e", { const: true, enum: ["x"] }),
			required("f", { default: 3, enum: [{ a: 1 }] }),
			required("g", { default: null }),
			required("h", { example: { a: 1 } }, { examples: "not a map" }),
			{ in: "query", name: "i", required: true },
			query("optional", { example: "x" }),
			{ example: "x", in: "header", name: "H", required: true },
		]
		expect(readRequiredQuery(parameters)).toEqual({ a: "param", b: "7", c: "listed", d: "schema", e: "true", f: "3" })
	})
})

const header = (name: string): ParameterObject => ({ in: "header", name })

describe("idempotencyHeader", () => {
	it("finds the header the operation accepts as an idempotency key, however it is spelled", () => {
		for (const name of ["Idempotency-Key", "x-idempotency-key", "Idempotence Key", "idempotency_key", "Idempotency"]) {
			expect(idempotencyHeader({ parameters: [query("q"), header(name)] })).toBe(name)
		}
		expect(idempotencyHeader({ parameters: [query("Idempotency-Key"), header("Key")] })).toBeNull()
		expect(idempotencyHeader({})).toBeNull()
	})
})

describe("successResponseHeaders", () => {
	it("names every header a 2xx response declares, once", () => {
		const op = {
			responses: {
				"200": { headers: { Link: {}, "X-Total": {} } },
				"201": { headers: { Link: {} } },
				"204": null,
				"206": {},
				"2XX": { headers: { Range: {} } },
				"400": { headers: { "X-Error": {} } },
			},
		} as unknown as OperationObject
		expect(successResponseHeaders(op)).toEqual(["Link", "X-Total"])
		expect(successResponseHeaders({})).toEqual([])
	})
})
