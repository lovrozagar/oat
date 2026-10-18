import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { commandServe, referenceFactory, type ServeDeps, untilSignal } from "./serve.ts"

type ReferenceOptions = Parameters<Awaited<ReturnType<ServeDeps["factoryFor"]>>>[0]

/* The demo API: started on the store asked for, described on stdout, stopped on a signal. */

function staged() {
	const started: Array<{ backend: string; options: ReferenceOptions }> = []
	const closed: string[] = []
	return {
		closed,
		deps: {
			factoryFor: async (backend: string) => async (options: ReferenceOptions) => {
				started.push({ backend, options })
				return { close: async () => void closed.push(backend), url: "http://127.0.0.1:4010" }
			},
			stopped: async () => undefined,
		},
		started,
	}
}

describe("commandServe", () => {
	it("serves a correct in-memory API by default, says how to use it, and closes it on stop", async () => {
		const { deps, started, closed } = staged()
		const writer = bufferWriter()
		expect(await commandServe(writer, {}, deps)).toBe(0)
		expect(started).toEqual([{ backend: "memory", options: { defects: [], untagged: false } }])
		expect(writer.text()).toContain("oat demo API — memory\n")
		expect(writer.text()).toContain("defects  none — a correct backend")
		expect(writer.text()).toContain("dialect  postgrest")
		expect(closed).toEqual(["memory"])
	})

	it("serves the store, defects, dialect and untagged document asked for", async () => {
		const { deps, started } = staged()
		const writer = bufferWriter()
		await commandServe(writer, { backend: "sqlite", defects: "A,,B", dialect: "classic", untagged: true }, deps)
		expect(started[0]).toEqual({
			backend: "sqlite",
			options: { defects: ["A", "B"], dialect: "classic", untagged: true },
		})
		expect(writer.text()).toContain("oat demo API — sqlite (untagged spec)")
		expect(writer.text()).toContain("defects  A, B")
	})
})

describe("referenceFactory", () => {
	it("is the reference backend's factory for each store, in memory for any other name", async () => {
		expect((await referenceFactory("sqlite")).name).toBe("createSqliteServer")
		expect((await referenceFactory("postgres")).name).toBe("createPostgresServer")
		expect((await referenceFactory("memory")).name).toBe("createMemoryServer")
		expect((await referenceFactory("d1")).name).toBe("createMemoryServer")
	})
})

describe("untilSignal", () => {
	it("resolves on SIGINT or SIGTERM, and stops listening", async () => {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const before = process.listenerCount(signal)
			const stopped = untilSignal()
			expect(process.listenerCount(signal)).toBe(before + 1)
			process.emit(signal, signal)
			await stopped
			expect(process.listenerCount(signal)).toBe(before)
		}
	})
})
