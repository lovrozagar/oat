import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { grammarTable } from "../support/grammar-table.ts"

/*
 * Today's filter, sort and select writers, pinned. Template grammars replace these writers with
 * one renderer whose presets must reproduce every term below byte for byte: a preset that drifts
 * would change the requests oat sends to every API that never declared a grammar.
 */

const PINNED = JSON.parse(
	readFileSync(new URL("../../src/spec/__fixtures__/grammar-characterization.json", import.meta.url), "utf8"),
) as Record<string, unknown>

describe("filter, sort and select terms", () => {
	it("render exactly as they did before template grammars", () => {
		expect(grammarTable()).toEqual(PINNED)
	})

	it("cover every grammar, operator and value shape", () => {
		expect(Object.keys(PINNED).length).toBeGreaterThan(1300)
	})
})
