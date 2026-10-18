import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { readEffects } from "./effects.ts"
import { GapCollector } from "./gaps.ts"

const op = (effects: unknown) => ({ "x-effects": effects }) as OperationObject

describe("x-effects", () => {
	it("reads each well-formed item with its count or min", () => {
		expect(
			readEffects(
				op([
					{ entity: "note", op: "create" },
					{ count: 2, entity: "tag", op: "append" },
					{ entity: "log", min: 1, op: "append" },
					{ count: Number.NaN, entity: "x", min: "1", op: "delete" },
					null,
					"note",
					{ entity: "note" },
					{ entity: 1, op: "create" },
				]),
			),
		).toEqual([
			{ entity: "note", op: "create" },
			{ count: 2, entity: "tag", op: "append" },
			{ entity: "log", min: 1, op: "append" },
			{ entity: "x", op: "delete" },
		])
	})

	it("drops an item that sets both count and min, with a gap", () => {
		const gaps = new GapCollector()
		expect(readEffects(op([{ count: 1, entity: "note", min: 1, op: "create" }]), "note.create", gaps)).toEqual([])
		readEffects(op([{ count: 1, entity: "tag", min: 1, op: "create" }]), undefined, gaps)
		readEffects(op([{ count: 1, entity: "tag", min: 1, op: "create" }]))
		expect(gaps.gaps).toEqual([
			{
				detail: 'item for "note" sets both count and min; use exactly one',
				operationId: "note.create",
				tag: "x-effects",
			},
			{ detail: 'item for "tag" sets both count and min; use exactly one', operationId: "", tag: "x-effects" },
		])
	})

	it("is empty without a list", () => {
		expect(readEffects({} as OperationObject)).toEqual([])
		expect(readEffects(op({ entity: "note" }))).toEqual([])
	})
})
