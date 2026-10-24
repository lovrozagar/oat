import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { enGbWords, QUOTED_FILES } from "../support/spelling.ts"

/*
 * oat is written in en-US: code, identifiers, messages, tests and docs. Each tracked text file is
 * split into words, camelCase and snake_case identifiers into their parts, and every word is looked
 * up in a list of en-GB spellings. Quoted third-party text keeps the spelling of its source.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const TEXT = /\.(ts|mts|mjs|js|json|jsonc|md|sh|yml|yaml|snap|txt)$/

describe("en-US spelling", () => {
	it("finds en-GB words in prose and inside identifiers, and quoted GitHub tokens aside", () => {
		expect(enGbWords("The behaviour of selectNestedHonoured and a SQL_FLAVOUR, catalogued.")).toEqual([
			"behaviour",
			"honoured",
			"flavour",
			"catalogued",
		])
		expect(enGbWords("reference sequence difference promise exercise controlled filled")).toEqual([])
		expect(enGbWords("if: ${{ !cancelled() }} and result == 'cancelled', but a run was cancelled")).toEqual([
			"cancelled",
		])
	})

	it("holds every tracked text file to en-US, quoted third-party text aside", () => {
		const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
			.split("\n")
			.filter((file) => TEXT.test(file) && !QUOTED_FILES.some((quoted) => quoted.test(file)))
		const hits = files.flatMap((file) => {
			const words = [...new Set(enGbWords(readFileSync(join(ROOT, file), "utf8")))]
			return words.length === 0 ? [] : [`${file}: ${words.join(", ")}`]
		})
		expect(hits).toEqual([])
	})
})
