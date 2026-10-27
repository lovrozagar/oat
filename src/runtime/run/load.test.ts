import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress/types.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { connected, fetchOf, notesApi, notesDoc, optionsFor, unreachable } from "./__fixtures__/api.ts"
import { load } from "./load.ts"

/*
 * The document read and modeled before anything else: served or on disk, through the fence when
 * served, with the status line saying when the network is being waited for.
 */

describe("load", () => {
	it("fetches a served document through the fence and models it", async () => {
		const asked: string[] = []
		const options = optionsFor(notesApi(), {
			hooks: {
				beforeRequest: (request) => {
					asked.push(`${request.phase} ${request.method} ${request.url}`)
					return { allow: true }
				},
			},
		})
		const loaded = await load(options)
		expect(asked).toEqual(["load GET http://api.test/openapi.json"])
		expect([...loaded.model.entities.keys()]).toEqual(["note"])
		expect(loaded.fence).toBeDefined()
		expect(loaded.profile.name).toBe("full")
		expect(loaded.hooks).toBe(options.hooks)
	})

	it("reads a document on disk without asking the fence, and runs with no hooks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-load-"))
		const spec = join(dir, "openapi.json")
		writeFileSync(spec, JSON.stringify(notesDoc()))
		/* No network options at all: a document on disk needs none. */
		const loaded = await load({ ...optionsFor(() => undefined, { spec }), network: {} })
		expect(loaded.fence).toBeUndefined()
		expect(loaded.hooks).toEqual({})
		expect(loaded.model.byOperationId.has("notes.create")).toBe(true)
	})

	it("refuses an unknown profile before it fetches anything", async () => {
		const options = optionsFor(notesApi(), { profile: "nope" })
		await expect(load(options)).rejects.toThrow(/nope/)
		expect(options.seen).toEqual([])
	})

	it("says on the status line when it waits for the network to fetch the document", async () => {
		const snaps: ProgressSnapshot[] = []
		const served = optionsFor(notesApi())
		let first = true
		const flaky: typeof fetch = (input, init) => {
			if (first && init?.method !== "HEAD") {
				first = false
				return unreachable(input, init)
			}
			return fetchOf(served)(input, init)
		}
		const loaded = await load({
			...served,
			network: { fetch: flaky, requestTimeoutMs: 5_000, retries: 0, waitMs: 5_000 },
			onProgress: (snap) => snaps.push(snap),
		})
		expect(loaded.model.entities.has("note")).toBe(true)
		expect(snaps.map((snap) => snap.message)).toContain("waiting for network (refused, 5s left)")
		expect(snaps.every((snap) => snap.phase === "load" && snap.requests === 0)).toBe(true)
	})
})

describe("load, the transcript option", () => {
	it("refuses a transcript option it cannot honor before it fetches anything", async () => {
		const options = optionsFor(notesApi(), { transcript: { memoryBytes: 0 } })
		await expect(load(options)).rejects.toThrow(UsageError)
		await expect(load(options)).rejects.toThrow(/transcript\.memoryBytes must be a positive integer/)
		expect(options.seen).toEqual([])
	})
})

describe("load, the secondary origins and the credentials config", () => {
	const cdn = {
		baseUrl: "http://cdn.test",
		id: "cdn",
		security: { bearer: "bearer" },
		spec: "http://cdn.test/openapi.json",
	}

	it("reads each origin's document once, with its overlay, and carries it modeled", async () => {
		const overlay = { operations: { "notes.list": { operationId: "cdn.notes.list" } } }
		const options = optionsFor(notesApi(), {
			origins: [
				{ ...cdn, overlay },
				{ ...cdn, id: "plain" },
			],
		})
		const loaded = await load(options)
		expect(options.seen.filter((seen) => seen.host === "cdn.test").map((seen) => seen.path)).toEqual([
			"/openapi.json",
			"/openapi.json",
		])
		expect(loaded.origins.get("cdn")?.model.byOperationId.has("cdn.notes.list")).toBe(true)
		expect(loaded.origins.get("plain")?.model.byOperationId.has("notes.list")).toBe(true)
		expect("x-auth-flows" in (loaded.origins.get("plain")?.doc ?? {})).toBe(false)
	})

	it("refuses credentials that do not fit the document, naming each problem", async () => {
		const refused = load(optionsFor(notesApi(), { origins: [cdn], security: { nope: { static: "x" } } }))
		await expect(refused).rejects.toThrow(UsageError)
		await expect(refused).rejects.toThrow(/security\.nope names no scheme in the document/)
	})

	it("leaves a secondary origin's run unchecked: the primary checked the config against its document", async () => {
		const primary = await connected(optionsFor(notesApi()))
		const shared = { mapping: {}, originOnly: new Set<string>(), store: primary.store }
		const loaded = await load(
			optionsFor(notesApi(), { security: { nope: { static: "x" } }, sharedCredentials: shared }),
		)
		expect(loaded.model.entities.has("note")).toBe(true)
	})
})

describe("load and the config's folder", () => {
	it("reads a relative document, and each origin's, from configDir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-load-"))
		writeFileSync(join(dir, "openapi.json"), JSON.stringify(notesDoc()))
		const origins = [{ baseUrl: "http://cdn.test", id: "cdn", security: { bearer: "bearer" }, spec: "openapi.json" }]
		const options = optionsFor(() => undefined, { configDir: dir, origins, spec: "openapi.json" })
		const loaded = await load({ ...options, network: {} })
		expect(loaded.model.byOperationId.has("notes.create")).toBe(true)
		expect(loaded.origins.get("cdn")?.model.byOperationId.has("notes.create")).toBe(true)
	})
})
