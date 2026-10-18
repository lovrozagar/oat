import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress.ts"
import { BASE, connected, notesApi, notesDoc, optionsFor } from "./__fixtures__/api.ts"

/*
 * The run's client and what watches it: every answer is journaled under its own check and shown
 * as the last one, and every client of the run — origins included — scrubs with one redactor.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "oat-connect-"))

describe("connect", () => {
	it("journals each answer under the check and entity that sent it, then shows it as the last", async () => {
		const dir = scratch()
		const snaps: ProgressSnapshot[] = []
		const run = await connected(optionsFor(notesApi(), { exchangeDir: dir, onProgress: (snap) => snaps.push(snap) }))
		await run.client.view({ check: "list.reads", purpose: "assertion", subject: "note" }).get("/notes")
		await run.journal?.flush()
		const lines = readFileSync(join(dir, "exchanges.jsonl"), "utf8").trim().split("\n")
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ check: "list.reads", entity: "note", phase: "load" })
		expect(snaps.at(-1)?.last).toMatchObject({ method: "GET", status: 200, url: `${BASE}/notes` })
		expect(run.progress.requests).toBe(1)
		expect(run.journal?.count).toBe(1)
	})

	it("keeps answering when the journal cannot be written", async () => {
		const blocked = join(scratch(), "a-file")
		writeFileSync(blocked, "not a directory")
		const run = await connected(optionsFor(notesApi(), { exchangeDir: join(blocked, "journal") }))
		const answered = await run.client.get("/notes")
		expect(answered.status).toBe(200)
	})

	it("journals nothing without a directory, and sets up the run's defaults", async () => {
		const run = await connected(optionsFor(notesApi()))
		expect(run.journal).toBeNull()
		expect(run).toMatchObject({ nonce: "n0nce", seed: 1 })
		const fresh = await connected({ ...optionsFor(notesApi()), nonce: undefined, seed: 7 } as never)
		expect(fresh.nonce).toMatch(/^[0-9a-f]{8}$/)
		expect(fresh.seed).toBe(7)
	})
})

describe("connect wiring", () => {
	it("sends the resolved headers, asks the fence, and paces by the configured rate", async () => {
		const asked: string[] = []
		const options = optionsFor(notesApi(), {
			hooks: {
				beforeRequest: (request) => {
					asked.push(`${request.method} ${request.url}`)
					return { allow: true }
				},
				resolveHeaders: async () => ({ "x-captcha": "solved" }),
			},
			maxRps: 1_000,
		})
		const run = await connected(options)
		await run.client.get("/notes")
		expect(asked.at(-1)).toBe(`GET ${BASE}/notes`)
		expect(options.seen.at(-1)?.headers["x-captcha"]).toBe("solved")
	})

	it("refuses a run with no principal", async () => {
		await expect(connected(optionsFor(notesApi(), { principals: [] }))).rejects.toThrow(
			"oat: at least one principal is required",
		)
	})

	it("gives every origin's client the run's redactor", async () => {
		const respond = notesApi()
		const origin = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }
		const run = await connected(
			optionsFor(
				(method, path, request) =>
					path === "/openapi.json" ? { body: notesDoc(), status: 200 } : respond(method, path, request),
				{
					origins: [origin],
				},
			),
		)
		expect(run.originClients.get("other")?.client.redactor).toBe(run.client.redactor)
	})
})
