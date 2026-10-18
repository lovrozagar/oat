import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress.ts"
import { fetchOf, notesApi, notesDoc, optionsFor, unreachable } from "./__fixtures__/api.ts"
import { load } from "./load.ts"

/*
 * The document read and modelled before anything else: served or on disk, through the fence when
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
