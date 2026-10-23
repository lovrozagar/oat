import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * A key read from a dictionary (a JSON body, headers, env) is written `obj["key"]`, as
 * noPropertyAccessFromIndexSignature asks, and a known shape gets a real type instead. A lint rule
 * that prefers dot access would undo the first, so none may be on.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, file), "utf8"))

describe("the strict TypeScript flags", () => {
	it("hold index-signature reads to brackets, and src declarations to explicit types", () => {
		const options = json("tsconfig.json")["compilerOptions"] as Record<string, unknown>
		expect(options["noPropertyAccessFromIndexSignature"]).toBe(true)
		expect(options["isolatedDeclarations"]).toBe(true)
	})

	it("are not fought by a lint rule that turns bracket access back into dots", () => {
		for (const file of [".oxlintrc.json", "oxlint.base.json"]) {
			const config = json(file)
			const overrides = (config["overrides"] ?? []) as Array<{ rules?: Record<string, unknown> }>
			const rules = [config["rules"] ?? {}, ...overrides.map((override) => override.rules ?? {})].flatMap((set) =>
				Object.keys(set),
			)
			expect(rules.filter((rule) => /(^|\/)dot-notation$/.test(rule))).toEqual([])
		}
	})
})
