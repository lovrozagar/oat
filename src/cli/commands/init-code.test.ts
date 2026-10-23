import { describe, expect, it } from "vitest"
import { fieldLines } from "./init-code.ts"

/* Code laid out as oxfmt lays it out, so formatting what `oat init` writes changes nothing. */

describe("fieldLines", () => {
	it("keeps a value on one line up to 120 columns, a tab counting two, and breaks it one column later", () => {
		/* Two tabs, `k: `, `["` and `"]`, then the comma. */
		const fits = "x".repeat(120 - 2 * 2 - "k: ".length - 4 - ",".length)
		expect(fieldLines([{ key: "k", value: [`"${fits}"`] }], 2)).toEqual([`\t\tk: ["${fits}"],`])
		expect(fieldLines([{ key: "k", value: [`"${fits}x"`] }], 2)).toEqual(["\t\tk: [", `\t\t\t"${fits}x",`, "\t\t],"])
	})

	it("quotes a key that is not an identifier, and breaks an object that holds a comment", () => {
		expect(fieldLines([{ key: "a-b", value: [{ key: "c", value: "1" }, { comment: "note" }] }], 0)).toEqual([
			'"a-b": {',
			"\tc: 1,",
			"\t// note",
			"},",
		])
		expect(fieldLines([{ key: "o", value: [{ comments: ["why"], key: "e", value: [] }] }], 1)).toEqual([
			"\to: {",
			"\t\t// why",
			"\t\te: {},",
			"\t},",
		])
	})
})
