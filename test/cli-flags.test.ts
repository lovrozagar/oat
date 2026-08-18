import { describe, expect, it } from "vitest"
import { KNOWN_FLAGS, main, parseArgs, unknownFlag, USAGE } from "../src/cli.ts"

describe("CLI flags", () => {
	it("does not advertise --concurrency in help", () => {
		expect(USAGE).not.toContain("--concurrency")
		expect(USAGE).toContain("--max-in-flight")
		expect(USAGE).toContain("./.oat/runs")
	})

	it("treats --concurrency as unknown (exit 2)", async () => {
		const { flags } = parseArgs(["run", "--config", "oat.config.ts", "--concurrency", "1"])
		expect(unknownFlag(flags)).toBe("concurrency")
		expect(KNOWN_FLAGS.has("concurrency")).toBe(false)
		const argv = process.argv
		process.argv = ["node", "oat", "run", "--concurrency", "1"]
		try {
			expect(await main()).toBe(2)
		} finally {
			process.argv = argv
		}
	})

	it("still accepts --max-in-flight", () => {
		const { flags } = parseArgs(["run", "--config", "oat.config.ts", "--max-in-flight", "8"])
		expect(unknownFlag(flags)).toBeUndefined()
		expect(flags["max-in-flight"]).toBe("8")
	})

	it("accepts --save-exchanges and --no-save-exchanges", () => {
		expect(USAGE).toContain("--save-exchanges")
		expect(USAGE).toContain("--no-save-exchanges")
		const on = parseArgs(["run", "--config", "oat.config.ts", "--save-exchanges"])
		expect(unknownFlag(on.flags)).toBeUndefined()
		expect(on.flags["save-exchanges"]).toBe(true)
		const off = parseArgs(["run", "--config", "oat.config.ts", "--no-save-exchanges"])
		expect(unknownFlag(off.flags)).toBeUndefined()
		expect(off.flags["no-save-exchanges"]).toBe(true)
	})
})
