import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

/* The executable: run as the program it starts the CLI; imported, as by bin/oat.js, it only offers `start`. */

const argv = process.argv

afterEach(() => {
	process.argv = argv
	process.exitCode = undefined
	vi.resetModules()
})

describe("the cli entry", () => {
	it("only offers start when imported", async () => {
		const entry = await import("./cli.ts")
		expect(typeof entry.start).toBe("function")
		expect(process.exitCode).toBeUndefined()
	})

	it("runs the command line when it is the program", async () => {
		process.argv = [argv[0] ?? "node", fileURLToPath(new URL("./cli.ts", import.meta.url)), "frobnicate"]
		const written: string[] = []
		const write = process.stderr.write
		process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof process.stderr.write
		try {
			await import("./cli.ts")
		} finally {
			process.stderr.write = write
		}
		expect(written.join("")).toMatch(/^oat: unknown command "frobnicate"/)
		expect(process.exitCode).toBe(2)
	})
})
