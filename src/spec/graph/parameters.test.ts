import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import type { JsonSchema, OperationObject, ParameterObject } from "../types.ts"
import {
	idempotencyHeader,
	readParamStyles,
	readRequiredCookies,
	readRequiredHeaders,
	readRequiredQuery,
	successResponseHeaders,
	unfilledRequired,
} from "./parameters.ts"

const required = (name: string, schema: JsonSchema, extra: Record<string, unknown> = {}) =>
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
		expect(readRequiredQuery(parameters)).toEqual({
			a: "param",
			b: 7,
			c: "listed",
			d: "schema",
			e: true,
			f: { a: 1 },
			h: { a: 1 },
		})
	})

	it("keeps an object or array example whole, for its style to write", () => {
		const parameters: ParameterObject[] = [
			required("range", { type: "object" }, { example: { max: 5, min: 1 }, style: "deepObject" }),
			required("ids", { items: { type: "string" }, type: "array" }, { example: ["a", "b"] }),
		]
		expect(readRequiredQuery(parameters)).toEqual({ ids: ["a", "b"], range: { max: 5, min: 1 } })
	})
})

const declared = (where: "cookie" | "header", name: string, example: unknown): ParameterObject => ({
	example,
	in: where,
	name,
	required: true,
})

describe("readRequiredHeaders and readRequiredCookies", () => {
	it("takes required header values, never the idempotency key, a content header or a credential's", () => {
		const op: OperationObject = {
			parameters: [
				declared("header", "X-Api-Version", "2"),
				declared("header", "X-Tags", ["a", "b"]),
				{ example: "x", in: "header", name: "X-Optional" },
				{ in: "header", name: "X-Unknown", required: true },
				declared("header", "Idempotency-Key", "k"),
				declared("header", "Accept", "text/csv"),
				declared("header", "content-type", "text/csv"),
				declared("header", "X-API-Key", "secret"),
				declared("cookie", "lang", "en"),
			],
		}
		expect(readRequiredHeaders(op)).toEqual({ "X-Api-Version": "2", "X-Tags": ["a", "b"] })
		expect(readRequiredCookies(op.parameters ?? [])).toEqual({ lang: "en" })
		expect(readRequiredHeaders({})).toEqual({})
	})
})

describe("readParamStyles", () => {
	it("keeps only what differs from the OAS default, by location and name", () => {
		const parameters: ParameterObject[] = [
			{ in: "query", name: "range", style: "deepObject" },
			{ explode: false, in: "query", name: "ids", style: "pipeDelimited" },
			{ explode: true, in: "query", name: "plain", style: "form" },
			{ explode: false, in: "query", name: "joined" },
			{ allowReserved: true, in: "query", name: "raw" },
			{ in: "path", name: "id", style: "label" },
			{ explode: false, in: "path", name: "same", style: "simple" },
			{ explode: true, in: "header", name: "X-Pairs" },
			{ in: "cookie", name: "c", style: 3 },
		]
		expect(readParamStyles(parameters)).toEqual({
			header: { "X-Pairs": { explode: true } },
			path: { id: { style: "label" } },
			query: {
				ids: { style: "pipeDelimited" },
				joined: { explode: false },
				range: { style: "deepObject" },
				raw: { allowReserved: true },
			},
		})
		expect(readParamStyles([])).toEqual({})
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

describe("unfilledRequired", () => {
	it("names each required query, header or cookie parameter with no declared value the run does not supply", () => {
		const op: OperationObject = {
			parameters: [
				{ in: "path", name: "id", required: true },
				required("albumId", { format: "uuid", type: "string" }),
				required("kind", { enum: ["photo"] }),
				query("optional", { type: "string" }),
				{ in: "header", name: "X-Tenant", required: true },
				{ example: "v2", in: "header", name: "X-Version", required: true },
				{ in: "header", name: "Idempotency-Key", required: true },
				{ in: "header", name: "Authorization", required: true },
				{ in: "cookie", name: "hint", required: true },
				{ example: "1", in: "cookie", name: "seen", required: true },
			],
			responses: {},
		}
		expect(unfilledRequired(op)).toEqual(["albumId", "X-Tenant", "hint"])
		expect(unfilledRequired({ responses: {} })).toEqual([])
	})
})
