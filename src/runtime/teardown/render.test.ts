import { describe, expect, it } from "vitest"
import { renderTeardown } from "./render.ts"
import type { TeardownReport, UnidentifiedCreate } from "./types.ts"

const report = (fields: Partial<TeardownReport> = {}): TeardownReport => ({
	failed: [],
	records: [],
	removed: 0,
	unidentified: [],
	unsupported: [],
	...fields,
})

const create = (seq: number): UnidentifiedCreate => ({
	entity: "note",
	method: "POST",
	operationId: "notes.create",
	seq,
	status: 201,
	url: "http://api.test/notes",
})

describe("renderTeardown", () => {
	it("says nothing when nothing was created or left", () => {
		expect(renderTeardown(report(), 0)).toEqual([])
		expect(renderTeardown(report({ removed: 2 }), 2)).toEqual(["  cleaned up 2/2 created record(s)"])
	})

	it("lists unsupported entities and at most five leftovers", () => {
		const failed = Array.from({ length: 7 }, (_, at) => ({
			entity: "note",
			id: `n${at}`,
			principal: "alpha",
			reason: "403",
		}))
		const lines = renderTeardown(report({ failed, removed: 1, unsupported: ["tag", "pin"] }), 9)
		expect(lines[0]).toBe("  cleanup: removed 1/9 created record(s)")
		expect(lines[1]).toMatch(/^ {4}tag, pin — no delete operation in the document/)
		expect(lines.slice(2)).toEqual([
			"    note n0 (as alpha): 403",
			"    note n1 (as alpha): 403",
			"    note n2 (as alpha): 403",
			"    note n3 (as alpha): 403",
			"    note n4 (as alpha): 403",
			"    … and 2 more",
		])
		expect(renderTeardown(report({ unsupported: ["tag"] }), 1)).toHaveLength(2)
		const one = [{ entity: "note", id: "n1", principal: "alpha", reason: "403" }]
		expect(renderTeardown(report({ failed: one }), 1)).toEqual([
			"  cleanup: removed 0/1 created record(s)",
			"    note n1 (as alpha): 403",
		])
	})

	it("lists creates whose record could not be identified, even with nothing else created", () => {
		const unidentified = Array.from({ length: 6 }, (_, at) => create(at + 1))
		const lines = renderTeardown(report({ unidentified }), 0)
		expect(lines[0]).toBe("  leftovers: 6 create(s) answered 2xx but no id could be read; the record may remain")
		expect(lines[1]).toBe("    notes.create POST http://api.test/notes → 201 (#1)")
		expect(lines.at(-1)).toBe("    … and 1 more")
		expect(renderTeardown(report({ unidentified: [create(1)] }), 0)).toHaveLength(2)
	})
})
