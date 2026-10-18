import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { EXIT } from "../runtime/exit.ts"
import { invokedDirectly, main, start } from "./main.ts"
import { bufferWriter } from "./writer.ts"

/*
 * The command line's front door: what it cannot parse it refuses with the help, help it prints,
 * and each command is handed what it reaches the world through.
 */

const quietServe = {
	factoryFor: async () => async () => ({ close: async () => undefined, url: "http://127.0.0.1:1" }),
	stopped: async () => undefined,
}

describe("main", () => {
	it("refuses an unknown flag and a flag it cannot read, with the help", async () => {
		const writer = bufferWriter()
		expect(await main(["run", "--concurrency", "1"], { writer })).toBe(2)
		expect(writer.text()).toMatch(/^oat: unknown flag "--concurrency"\n\noat — OpenAPI Tester/)
		const second = bufferWriter()
		expect(await main(["run", "--jobs", "0"], { writer: second })).toBe(2)
		expect(second.text()).toMatch(/^oat: --jobs must be a positive integer/)
	})

	it("prints the help for help, for --help, and for nothing at all", async () => {
		for (const argv of [["help"], ["run", "--help"], []]) {
			const writer = bufferWriter()
			expect(await main(argv, { writer })).toBe(0)
			expect(writer.text()).toMatch(/^oat — OpenAPI Tester/)
		}
	})

	it("refuses a command it does not know, before reading anything", async () => {
		const writer = bufferWriter()
		expect(await main(["frobnicate"], { writer })).toBe(2)
		expect(writer.text()).toMatch(/^oat: unknown command "frobnicate"/)
	})

	it("hands each command its writer and what it reaches the world through", async () => {
		const writer = bufferWriter()
		expect(await main(["serve"], { serve: quietServe, writer })).toBe(0)
		expect(writer.text()).toContain("url      http://127.0.0.1:1")
		expect(await main(["diff"], { writer })).toBe(2)
		expect(await main(["baseline"], { writer })).toBe(2)
		expect(await main(["plan"], { writer })).toBe(2)
		expect(await main(["doctor"], { writer })).toBe(2)
		expect(await main(["run"], { writer })).toBe(2)
		expect(
			await main(["conformance", "--backend", "nope"], {
				toolkit: async () => ({ dialect: { DIALECTS: {} } }) as never,
				writer,
			}),
		).toBe(2)
		expect(writer.text()).toContain('oat: unknown --backend "nope"')
	})
})

describe("start", () => {
	const argv = process.argv
	afterEach(() => {
		process.argv = argv
		process.exitCode = undefined
	})

	it("sets the process's exit code to the command's", async () => {
		process.argv = ["node", "oat", "frobnicate"]
		await start({ writer: bufferWriter() })
		expect(process.exitCode).toBe(2)
	})

	it("reports an error no command expected in one line, and fails", async () => {
		process.argv = ["node", "oat", "serve"]
		const writer = bufferWriter()
		const broken = {
			factoryFor: async () => Promise.reject(new Error("no ports left")),
			stopped: async () => undefined,
		}
		await start({ serve: broken, writer })
		expect(writer.text()).toBe("oat: no ports left\n")
		expect(process.exitCode).toBe(EXIT.failed)
	})

	it("writes to the process's own streams by default", async () => {
		process.argv = ["node", "oat", "frobnicate"]
		const written: string[] = []
		const write = process.stderr.write
		process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof process.stderr.write
		try {
			await start()
		} finally {
			process.stderr.write = write
		}
		expect(written.join("")).toMatch(/^oat: unknown command/)
	})
})

describe("invokedDirectly", () => {
	it("is true for the module run as the program, through a symlink too", () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-entry-"))
		const real = join(dir, "cli.js")
		writeFileSync(real, "")
		const link = join(dir, "oat")
		symlinkSync(real, link)
		const url = pathToFileURL(real).href
		expect(invokedDirectly(real, url)).toBe(true)
		expect(invokedDirectly(link, url)).toBe(true)
		expect(invokedDirectly(join(dir, "other.js"), url)).toBe(false)
		expect(invokedDirectly(undefined, url)).toBe(false)
	})

	it("compares as written when a path cannot be resolved", () => {
		const missing = join(tmpdir(), "oat-no-such-dir", "cli.js")
		expect(invokedDirectly(missing, pathToFileURL(missing).href)).toBe(true)
	})
})
