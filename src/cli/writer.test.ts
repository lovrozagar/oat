import { afterEach, describe, expect, it, vi } from "vitest"
import { bufferWriter, processWriter } from "./writer.ts"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("writer", () => {
	it("writes results to stdout and diagnostics to stderr", () => {
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const uncork = vi.spyOn(process.stdout, "uncork").mockImplementation(() => undefined)
		processWriter.out("result\n")
		processWriter.err("warning\n")
		processWriter.flush()
		expect(out).toHaveBeenCalledWith("result\n")
		expect(err).toHaveBeenCalledWith("warning\n")
		expect(uncork).toHaveBeenCalledOnce()
	})

	it("buffers both streams in order", () => {
		const writer = bufferWriter()
		writer.out("a")
		writer.err("b")
		writer.flush()
		expect(writer.text()).toBe("ab")
	})
})
