import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { ENTITIES } from "../model/entities.ts"
import type { FieldDef } from "../model/types.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import { type BodyRules, coerceField, emptyValue, formFields, pathId, validateBody } from "./validation.ts"

const CLEAN = new DefectSet()
const defects = (...names: string[]): DefectSet => new DefectSet(names)
const field = (more: Partial<FieldDef>): FieldDef => ({ name: "f", type: "string", ...more })
const UUID = "123e4567-e89b-42d3-a456-426614174000"
/* A create of a table, with no defect: what each case below departs from. */
const CREATE: BodyRules = { defects: CLEAN, entity: TABLE, mode: "create" }

describe("validateBody", () => {
	it("keeps the writable fields, coerced", () => {
		expect(validateBody({ name: "a", position: 3, status: "draft" }, CREATE)).toEqual({
			name: "a",
			position: 3,
			status: "draft",
		})
	})

	it("refuses a body that is not a JSON object", () => {
		for (const body of [null, "text", [1]]) {
			expect(() => validateBody(body, CREATE)).toThrow("request body must be a JSON object")
		}
	})

	it("refuses an unknown field, and a generated or immutable one unless IMMUTABLE_WRITABLE", () => {
		expect(() => validateBody({ name: "a", nope: 1 }, CREATE)).toThrow('unknown field "nope"')
		expect(() => validateBody({ name: "a", id: "x" }, CREATE)).toThrow('field "id" is not writable')
		expect(validateBody({ id: "x", name: "a" }, { ...CREATE, defects: defects("IMMUTABLE_WRITABLE") })).toEqual({
			id: "x",
			name: "a",
		})
	})

	it("refuses a create-only field on update as unknown", () => {
		const entity = { ...JOB, fields: [...JOB.fields, field({ createOnly: true, name: "seed" })] }
		expect(validateBody({ name: "a", seed: "s" }, { ...CREATE, entity })).toEqual({
			name: "a",
			seed: "s",
		})
		expect(() => validateBody({ seed: "s" }, { ...CREATE, entity, mode: "update" })).toThrow('unknown field "seed"')
	})

	it("keeps only keys it admitted, even when the body grows while it is read", () => {
		const body: Record<string, unknown> = {
			get name() {
				body.smuggled = true
				return "a"
			},
		}
		expect(validateBody(body, CREATE)).toEqual({ name: "a" })
	})

	it("requires every required field on create and replace, not on update", () => {
		expect(() => validateBody({}, CREATE)).toThrow('field "name" is required')
		expect(() => validateBody({}, { ...CREATE, mode: "replace" })).toThrow('field "name" is required')
		expect(validateBody({}, { ...CREATE, mode: "update" })).toEqual({})
		expect(validateBody({}, { ...CREATE, defects: defects("REQUIRED_NOT_VALIDATED") })).toEqual({})
	})
})

describe("coerceField", () => {
	it("admits null only where the field is nullable", () => {
		expect(coerceField(field({ nullable: true }), null, CLEAN)).toBeNull()
		expect(() => coerceField(field({}), null, CLEAN)).toThrow('field "f" is not nullable')
	})

	it("checks numbers: finite, integral where declared, and in range", () => {
		const weight = field({ maximum: 10, minimum: 1, multipleOf: 0.5, type: "number" })
		expect(coerceField(weight, 2.5, CLEAN)).toBe(2.5)
		expect(() => coerceField(weight, "2", CLEAN)).toThrow("must be a number")
		expect(() => coerceField(weight, Number.POSITIVE_INFINITY, CLEAN)).toThrow("must be a number")
		expect(() => coerceField(field({ type: "integer" }), 1.5, CLEAN)).toThrow("must be an integer")
		for (const value of [0, 11, 2.25]) expect(() => coerceField(weight, value, CLEAN)).toThrow("is out of range")
		expect(coerceField(field({ type: "integer" }), 4, CLEAN)).toBe(4)
	})

	it("checks a list against its allowed elements and length", () => {
		const tags = field({ items: ["red", "blue"], name: "tags", type: "array" })
		const sent = ["red"]
		const kept = coerceField(tags, sent, CLEAN)
		expect(kept).toEqual(["red"])
		expect(kept).not.toBe(sent)
		for (const value of ["red", ["red", "red", "red", "red", "red", "red"], [1], ["green"]]) {
			expect(() => coerceField(tags, value, CLEAN)).toThrow('field "tags" must be a list of red, blue')
		}
		expect(() => coerceField(field({ type: "array" }), ["x"], CLEAN)).toThrow("must be a list of ")
	})

	it("checks a point: exactly two integer coordinates", () => {
		const point = field({ ref: "Point", type: "object" })
		expect(coerceField(point, { x: 1, y: 2 }, CLEAN)).toEqual({ x: 1, y: 2 })
		for (const value of ["1,2", [1, 2], { x: 1 }, { x: 1, y: 2, z: 3 }, { x: 1.5, y: 2 }, { x: 1, y: "2" }]) {
			expect(() => coerceField(point, value, CLEAN)).toThrow('field "f" must be a Point')
		}
		expect(() => coerceField(field({ ref: "TreeNode", type: "object" }), { x: 1, y: 2 }, CLEAN)).toThrow(
			"must be a TreeNode",
		)
		expect(() => coerceField(field({ type: "object" }), {}, CLEAN)).toThrow("must be a object")
	})

	it("checks a boolean", () => {
		expect(coerceField(field({ type: "boolean" }), false, CLEAN)).toBe(false)
		expect(() => coerceField(field({ type: "boolean" }), "true", CLEAN)).toThrow("must be a boolean")
	})
})

describe("coerceField on strings", () => {
	it("refuses a non-string", () => {
		expect(() => coerceField(field({}), 1, CLEAN)).toThrow('field "f" must be a string')
	})

	it("enforces maxLength and enum unless their defects are on", () => {
		const short = field({ maxLength: 2 })
		expect(() => coerceField(short, "abc", CLEAN)).toThrow("exceeds maxLength")
		expect(coerceField(short, "abc", defects("MAXLENGTH_NOT_VALIDATED"))).toBe("abc")
		const status = field({ enum: ["a", "b"] })
		expect(() => coerceField(status, "c", CLEAN)).toThrow('field "f" must be one of a, b')
		expect(coerceField(status, "c", defects("ENUM_NOT_VALIDATED"))).toBe("c")
	})

	it("enforces a const", () => {
		expect(coerceField(field({ const: "v1" }), "v1", CLEAN)).toBe("v1")
		expect(() => coerceField(field({ const: "v1" }), "v2", CLEAN)).toThrow('field "f" must be "v1"')
	})

	it("enforces the date-time and uuid formats", () => {
		const due = field({ format: "date-time" })
		expect(coerceField(due, "2024-01-02T03:04:05.123+01:00", CLEAN)).toBe("2024-01-02T03:04:05.123+01:00")
		for (const value of ["2024-01-02", "2024-13-45T00:00:00Z"]) {
			expect(() => coerceField(due, value, CLEAN)).toThrow("must be an RFC 3339 date-time")
		}
		expect(coerceField(field({ format: "uuid" }), UUID, CLEAN)).toBe(UUID)
		expect(() => coerceField(field({ format: "uuid" }), "nope", CLEAN)).toThrow("must be a UUID")
	})

	it("strips non-ASCII and trims under STRING_PAYLOAD_MANGLED", () => {
		expect(coerceField(field({}), " café\u0000 ", CLEAN)).toBe(" café\u0000 ")
		expect(coerceField(field({}), " café\u0000 ", defects("STRING_PAYLOAD_MANGLED"))).toBe("caf")
	})
})

describe("emptyValue", () => {
	it("is the zero of each type, or the first enum value", () => {
		expect(emptyValue(field({ nullable: true, type: "integer" }))).toBeNull()
		expect(emptyValue(field({ type: "array" }))).toEqual([])
		expect(emptyValue(field({ type: "boolean" }))).toBe(false)
		expect(emptyValue(field({ type: "integer" }))).toBe(0)
		expect(emptyValue(field({ type: "number" }))).toBe(0)
		expect(emptyValue(field({ enum: ["x", "y"] }))).toBe("x")
		expect(emptyValue(field({}))).toBe("")
	})
})

describe("pathId", () => {
	it("reads an integer identity as a number, and refuses a malformed one", () => {
		const entities = shapedEntities({ ids: "integer" })
		expect(pathId(entities, "table_id", "42")).toBe(42)
		for (const raw of ["0", "042", "4x", "1234567890123456"]) {
			expect(() => pathId(entities, "table_id", raw)).toThrow(`"${raw}" is not a valid table_id`)
		}
	})

	it("refuses a malformed uuid identity", () => {
		const entities = shapedEntities({ ids: "uuid" })
		expect(pathId(entities, "row_id", UUID)).toBe(UUID)
		expect(() => pathId(entities, "row_id", "nope")).toThrow('"nope" is not a valid row_id')
	})

	it("keeps a string identity, or a parameter no entity owns, as written", () => {
		expect(pathId(ENTITIES, "table_id", "anything")).toBe("anything")
		expect(pathId(ENTITIES, "project_id", "proj_alpha")).toBe("proj_alpha")
	})
})

describe("formFields", () => {
	it("reads each field as its declared type", () => {
		expect(formFields(ROW, "label=a&amount=2.5&active=true&tags=red&tags=blue&extra=x")).toEqual({
			active: true,
			amount: 2.5,
			extra: "x",
			label: "a",
			tags: ["red", "blue"],
		})
	})

	it("keeps a value that is not of its type as sent, for validation to refuse", () => {
		expect(formFields(TABLE, "position=+&name=n")).toEqual({ name: "n", position: " " })
		expect(formFields(ROW, "active=false")).toEqual({ active: false })
		expect(formFields(ROW, "active=yes&amount=x")).toEqual({ active: "yes", amount: Number.NaN })
	})
})
