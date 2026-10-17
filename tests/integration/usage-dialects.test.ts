import { describe, expect, it } from "vitest"
import { USAGE } from "../../src/cli.ts"
import { DIALECTS } from "../../src/reference/dialect.ts"

/* A dialect `--dialect` accepts but the help does not name is one nobody finds. */

describe("--dialect help", () => {
	it("names every dialect the reference speaks", () => {
		const line = USAGE.split("\n").find((text) => text.trimStart().startsWith("--dialect")) ?? ""
		for (const name of Object.keys(DIALECTS)) expect(line).toContain(name)
	})
})
