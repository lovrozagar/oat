import { describe, expect, it } from "vitest"
import { env, MissingEnvError } from "./env.ts"

describe("env", () => {
	it("reads a set variable", () => {
		expect(env("TOKEN", { TOKEN: "t" })).toBe("t")
	})

	it("refuses an unset or empty one, naming it, rather than sending an empty credential", () => {
		expect(() => env("TOKEN", {})).toThrow(new MissingEnvError("TOKEN"))
		expect(() => env("TOKEN", { TOKEN: "" })).toThrow("oat: env TOKEN is not set")
	})

	it("reads the process environment by default", () => {
		process.env["OAT_ENV_TEST_SET"] = "yes"
		try {
			expect(env("OAT_ENV_TEST_SET")).toBe("yes")
		} finally {
			delete process.env["OAT_ENV_TEST_SET"]
		}
	})
})
