import { describe, expect, it } from "vitest"
import type { OperationObject, JsonSchema } from "../types.ts"
import { GapCollector } from "./gaps.ts"
import { readPrivileged, requiredPrivileged } from "./privileged.ts"

/* `x-privileged: true` on a request body property: only the highest-rank principal may set it. */

const table: JsonSchema = {
	properties: {
		meta: {
			properties: { owner: { type: "string", "x-privileged": true }, tag: { type: "string" } },
			type: "object",
		},
		name: { type: "string" },
		verified: { type: "boolean", "x-privileged": true },
	},
	type: "object",
}

const read = (body: JsonSchema | null): string[] =>
	readPrivileged({} as OperationObject, { body, gaps: new GapCollector(), operationId: "op" })

describe("readPrivileged", () => {
	it("names every marked property of the request body, nested ones by their dotted path", () => {
		const gaps = new GapCollector()
		expect(readPrivileged({} as OperationObject, { body: table, gaps, operationId: "table.update" })).toEqual([
			"meta.owner",
			"verified",
		])
		expect(gaps.gaps).toEqual([])
	})

	it("reads the properties of each allOf member, a property marked false as unmarked, and no body as none", () => {
		const merged: JsonSchema = { allOf: [table, { properties: { plan: { "x-privileged": false } } }] }
		expect(read(merged)).toEqual(["meta.owner", "verified"])
		expect(read(null)).toEqual([])
		expect(read({ properties: { tags: { items: { type: "string" }, type: "array" } } })).toEqual([])
	})

	it("reports a marker that is not a boolean, or not on a schema property, and does not read it", () => {
		const gaps = new GapCollector()
		const body: JsonSchema = {
			properties: { plan: { type: "string", "x-privileged": "admin" } },
			type: "object",
			"x-privileged": true,
		}
		const op = { "x-privileged": true } as unknown as OperationObject
		expect(readPrivileged(op, { body, gaps, operationId: "project.update" })).toEqual([])
		expect(gaps.gaps).toEqual([
			{
				detail: "x-privileged belongs on a request body property, not on the operation; oat cannot use it",
				operationId: "project.update",
				tag: "x-privileged",
			},
			{
				detail: "x-privileged belongs on a request body property, not on the body itself; oat cannot use it",
				operationId: "project.update",
				tag: "x-privileged",
			},
			{
				detail: 'x-privileged on property "plan" must be true or false; oat cannot use it',
				operationId: "project.update",
				tag: "x-privileged",
			},
		])
	})

	it("stops at a schema it has already walked", () => {
		const node: JsonSchema = { properties: {}, type: "object" }
		;(node.properties as Record<string, unknown>)["self"] = node
		;(node.properties as Record<string, unknown>)["flag"] = { "x-privileged": true }
		expect(readPrivileged({} as OperationObject, { body: node, gaps: new GapCollector(), operationId: "op" })).toEqual([
			"flag",
		])
	})
})

describe("requiredPrivileged", () => {
	it("keeps a marked path only when every segment of it is required where it sits, allOf members included", () => {
		const marked = ["meta.owner", "verified"]
		expect(requiredPrivileged(table, marked)).toEqual([])
		expect(requiredPrivileged({ ...table, required: ["verified", "meta"] }, marked)).toEqual(["verified"])
		const owner = { properties: { owner: { type: "string", "x-privileged": true } }, required: ["owner"] }
		const nested: JsonSchema = { allOf: [{ required: ["meta"] }], properties: { meta: { allOf: [owner] } } }
		expect(requiredPrivileged(nested, marked)).toEqual(["meta.owner"])
		expect(requiredPrivileged({ properties: { meta: true }, required: ["meta"] }, ["meta.owner"])).toEqual([])
		expect(requiredPrivileged(null, marked)).toEqual([])
	})
})
