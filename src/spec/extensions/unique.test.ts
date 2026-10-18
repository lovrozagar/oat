import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { GapCollector } from "./gaps.ts"
import { formatUniqueSets, readUnique } from "./unique.ts"

const op = (unique: unknown) => ({ "x-unique": unique }) as OperationObject

describe("x-unique", () => {
	it("reads every accepted shape", () => {
		expect(readUnique(op([["email"], ["workspace_id", "slug"]]))).toEqual([["email"], ["workspace_id", "slug"]])
		expect(readUnique(op([{ columns: ["email", ""] }, [], { columns: [] }]))).toEqual([["email"]])
		expect(readUnique(op(["workspace_id", "slug", ""]))).toEqual([["workspace_id", "slug"]])
		expect(readUnique(op([""]))).toEqual([])
		expect(readUnique(op([]))).toEqual([])
	})

	it("is null without a tag, and null with a gap when malformed", () => {
		const gaps = new GapCollector()
		expect(readUnique({} as OperationObject, "a", gaps)).toBeNull()
		expect(readUnique(op("email"), "a", gaps)).toBeNull()
		expect(readUnique(op([["email", 1]]), "b", gaps)).toBeNull()
		expect(readUnique(op([{ columns: [1] }]), "c", gaps)).toBeNull()
		expect(readUnique(op([1, "email"]), undefined, gaps)).toBeNull()
		expect(readUnique(op([null]), undefined, gaps)).toBeNull()
		expect(readUnique(op({ columns: ["email"] }), undefined, gaps)).toBeNull()
		expect(readUnique(op([{ name: "email" }]))).toBeNull()
		expect(gaps.gaps.map((gap) => gap.operationId)).toEqual(["a", "b", "c", "", "", ""])
		expect(gaps.gaps[0]).toEqual({
			detail: "x-unique is not a list of column sets; unique-conflict checks will not run",
			operationId: "a",
			tag: "x-unique",
		})
	})

	it("formats sets for the plan", () => {
		expect(formatUniqueSets(null)).toBe("—")
		expect(formatUniqueSets([])).toBe("(none)")
		expect(formatUniqueSets([["email"], ["workspace_id", "slug"]])).toBe("[email]; [workspace_id, slug]")
	})
})
