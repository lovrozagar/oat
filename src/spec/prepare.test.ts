import { describe, expect, it } from "vitest"
import type { Scenario } from "../config/types/steps.ts"
import { doc } from "./__fixtures__/documents.ts"
import { prepareDocument } from "./prepare.ts"

const source = doc({
	"/notes": { get: { operationId: "notes.list" }, post: { operationId: "notes.create" } },
	"/tags": { get: { operationId: "tags.list" } },
})

describe("prepareDocument", () => {
	it("returns the document untouched when the config neither patches nor prunes it", () => {
		expect(prepareDocument(source, {})).toBe(source)
	})

	it("applies the overlay, then removes everything outside allow, reporting what went", () => {
		const removed: string[][] = []
		const out = prepareDocument(
			source,
			{ allow: ["notes.list"], overlay: { operations: { "notes.list": { summary: "patched" } } } },
			(ids) => removed.push(ids),
		)
		expect(out.paths).toEqual({ "/notes": { get: { operationId: "notes.list", summary: "patched" } } })
		expect(removed).toEqual([["notes.create", "tags.list"]])
		expect(prepareDocument(source, { allow: ["tags.list"] }).paths).toEqual({
			"/tags": { get: { operationId: "tags.list" } },
		})
	})

	it("refuses an allowlist that removes an operation the config still calls", () => {
		const scenario = { covers: [], id: "s", steps: [{ operationId: "notes.create" }] } as unknown as Scenario
		expect(() => prepareDocument(source, { allow: ["notes.list"], scenarios: [scenario] })).toThrow(
			'allow removes operations the config still calls: scenario "s" step "notes.create"',
		)
	})
})
