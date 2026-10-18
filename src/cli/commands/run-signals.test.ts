import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { signalExit, type SignalSource, stopOnSignal } from "./run-signals.ts"

/* The first signal stops testing and still cleans up; a second exits at once. */

function source() {
	const emitter = new EventEmitter()
	const exits: number[] = []
	const signals: SignalSource = {
		exit: ((code: number) => {
			exits.push(code)
			throw new Error(`exit ${code}`)
		}) as SignalSource["exit"],
		off: (signal, listener) => emitter.off(signal, listener),
		on: (signal, listener) => emitter.on(signal, listener),
	}
	return { emitter, exits, signals }
}

describe("stopOnSignal", () => {
	it("aborts the run on the first signal, and remembers which", () => {
		const { emitter, signals } = source()
		const writer = bufferWriter()
		const stop = stopOnSignal(writer, signals)
		expect(stop.by()).toBeUndefined()
		emitter.emit("SIGTERM", "SIGTERM")
		expect(stop.signal.aborted).toBe(true)
		expect(stop.by()).toBe("SIGTERM")
		expect(writer.text()).toBe("\noat: SIGTERM — stopping, removing what this run created (again to exit now)\n")
	})

	it("exits at once on a second signal", () => {
		const { emitter, exits, signals } = source()
		const writer = bufferWriter()
		stopOnSignal(writer, signals)
		emitter.emit("SIGINT", "SIGINT")
		expect(() => emitter.emit("SIGINT", "SIGINT")).toThrow("exit 130")
		expect(exits).toEqual([130])
		expect(writer.text()).toContain("oat: SIGINT again — exiting without teardown")
	})

	it("stops listening once disposed", () => {
		const { emitter, signals } = source()
		const stop = stopOnSignal(bufferWriter(), signals)
		stop.dispose()
		expect(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM")).toBe(0)
	})

	it("listens to the process by default", () => {
		const before = process.listenerCount("SIGINT")
		const stop = stopOnSignal(bufferWriter())
		expect(process.listenerCount("SIGINT")).toBe(before + 1)
		stop.dispose()
		expect(process.listenerCount("SIGINT")).toBe(before)
	})
})

describe("signalExit", () => {
	it("is the shell's code for the signal", () => {
		expect(signalExit("SIGINT")).toBe(130)
		expect(signalExit("SIGTERM")).toBe(143)
	})
})
