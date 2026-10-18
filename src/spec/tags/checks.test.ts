import { describe, expect, it } from "vitest"
import {
	checkAxis,
	checkShape,
	flag,
	integer,
	isObject,
	oneOf,
	positive,
	route,
	text,
	textMap,
	texts,
} from "./checks.ts"

describe("value checks", () => {
	it("accept what they describe and say what is wrong with anything else", () => {
		expect([text("a"), text(""), text(1)]).toEqual([null, "must be a non-empty string", "must be a non-empty string"])
		expect([flag(false), flag("yes")]).toEqual([null, "must be true or false"])
		expect([route(" GET /a "), route("/a"), route(5)]).toEqual([
			null,
			'must be a route like "GET /path"',
			'must be a route like "GET /path"',
		])
		expect([texts(["a"]), texts(["a", 1]), texts("a")]).toEqual([
			null,
			"must be an array of strings",
			"must be an array of strings",
		])
		expect([positive(0.5), positive(0), positive("1")]).toEqual([
			null,
			"must be a positive number",
			"must be a positive number",
		])
		expect([integer(2), integer(1.5), integer(0), integer("2")]).toEqual([
			null,
			"must be a positive integer",
			"must be a positive integer",
			"must be a positive integer",
		])
		expect([textMap({ a: "b" }), textMap({ a: 1 }), textMap(["a"])]).toEqual([
			null,
			"must map names to strings",
			"must map names to strings",
		])
	})

	it("tell a plain object from an array or null", () => {
		expect([isObject({}), isObject([]), isObject(null), isObject("x")]).toEqual([true, false, false, false])
	})

	it("list the allowed values when one is not among them", () => {
		expect(oneOf("a", ["a", "b"])).toBeNull()
		expect(oneOf(3, ["a", "b"])).toBe('must be one of "a", "b"')
	})
})

describe("checkShape", () => {
	const fields = { name: text, rps: positive }

	it("needs an object with every required field", () => {
		expect(checkShape([], fields)).toBe("must be an object")
		expect(checkShape({ rps: 1 }, fields, ["name"])).toBe('needs "name"')
	})

	it("checks each known field that is present, naming the first that fails", () => {
		expect(checkShape({ extra: 1, name: "n", rps: undefined }, fields, ["name"])).toBeNull()
		expect(checkShape({ name: "n", rps: -1 }, fields)).toBe('"rps" must be a positive number')
	})
})

describe("checkAxis", () => {
	const row = { field: text, type: text }

	it("accepts field names, rows with a field, or null for none", () => {
		expect(checkAxis(null, row)).toBeNull()
		expect(checkAxis(["a", { field: "b", type: "string" }], row)).toBeNull()
	})

	it("says what is wrong with the axis or its first bad row", () => {
		expect(checkAxis("a", row)).toBe("must be an array of field names or { field } rows")
		expect(checkAxis(["a", { type: "string" }], row)).toBe('has a row that needs "field"')
		expect(checkAxis([{ field: "a", type: 1 }], row)).toBe('has a row that "type" must be a non-empty string')
	})
})
