import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress/types.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import {
	ALPHA_KEY,
	BASE,
	connected,
	LOGIN,
	notesApi,
	notesDoc,
	optionsFor,
	servingAt,
	withLogin,
} from "./__fixtures__/api.ts"

/*
 * The run's client and what watches it: every answer is journaled under its own check and shown
 * as the last one, every client of the run — origins included — scrubs with one redactor, and each
 * resolves its actors over the run's one store against its own document.
 */

const AS_ALPHA = { as: { principal: "alpha" } }
const ORIGIN = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }

const scratch = (): string => mkdtempSync(join(tmpdir(), "oat-connect-"))

describe("connect", () => {
	it("journals each answer under the check and entity that sent it, then shows it as the last", async () => {
		const dir = scratch()
		const snaps: ProgressSnapshot[] = []
		const run = await connected(optionsFor(notesApi(), { exchangeDir: dir, onProgress: (snap) => snaps.push(snap) }))
		await run.client.view({ check: "list.reads", purpose: "assertion", subject: "note" }).get("/notes", AS_ALPHA)
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
		const answered = await run.client.get("/notes", AS_ALPHA)
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
		await run.client.get("/notes", AS_ALPHA)
		expect(asked.at(-1)).toBe(`GET ${BASE}/notes`)
		expect(options.seen.at(-1)?.headers["x-captcha"]).toBe("solved")
	})

	it("refuses a run with no principal", async () => {
		await expect(connected(optionsFor(notesApi(), { principals: {} }))).rejects.toThrow(
			"principals declares no principal",
		)
	})

	it("sends each request the credential its actor holds, and registers the config's extra secret headers", async () => {
		const options = optionsFor(notesApi(), { redact: { headers: ["x-tester-key"] } })
		const run = await connected(options)
		await run.client.get("/notes", AS_ALPHA)
		expect(options.seen.at(-1)?.headers.authorization).toBe(`Bearer ${ALPHA_KEY}`)
		expect(run.client.redactor.isSecretHeader("x-tester-key")).toBe(true)
	})
})

describe("connect: the store", () => {
	it("signs in through the run's own client when a request first needs the credential", async () => {
		const options = optionsFor(withLogin(), { security: LOGIN })
		const run = await connected(options)
		await run.client.get("/notes", AS_ALPHA)
		expect(options.seen.map((request) => [request.path, request.headers.authorization])).toEqual([
			["/openapi.json", undefined],
			["/login", undefined],
			["/notes", "Bearer token-1"],
		])
	})

	it("sends nothing for an API whose config names no recipe", async () => {
		const { security: _none, ...bare } = optionsFor(notesApi())
		const run = await connected(bare)
		await expect(run.client.get("/notes", AS_ALPHA)).rejects.toThrow("no credential for bearer")
	})

	it("resolves a secondary origin's run over the primary's store, by the origin's mapping", async () => {
		const primary = await connected(optionsFor(notesApi()))
		const options = optionsFor(notesApi(), {
			sharedCredentials: { mapping: { bearer: "bearer" }, store: primary.store },
		})
		const run = await connected(options)
		await run.client.get("/notes", AS_ALPHA)
		expect(options.seen.at(-1)?.headers.authorization).toBe(`Bearer ${ALPHA_KEY}`)
	})
})

describe("connect: secondary origins", () => {
	it("gives each origin's client the run's redactor, and an adapter over the run's store mapping its schemes", async () => {
		const options = optionsFor(notesApi(), { origins: [{ ...ORIGIN, security: { bearer: "bearer" } }] })
		const run = await connected(options)
		const origin = run.originClients.get("other")
		expect(origin?.client.redactor).toBe(run.client.redactor)
		await origin?.client.get("/notes", AS_ALPHA)
		expect(options.seen.at(-1)).toMatchObject({ headers: { authorization: `Bearer ${ALPHA_KEY}` }, host: "other.test" })
	})

	it("sends nothing for an origin scheme no mapping names", async () => {
		const doc = notesDoc() as unknown as { components: { securitySchemes: Record<string, unknown> }; security: unknown }
		doc.components.securitySchemes = { originKey: { in: "header", name: "x-origin-key", type: "apiKey" } }
		doc.security = [{ originKey: [] }]
		const run = await connected(servingAt(optionsFor(notesApi(), { origins: [ORIGIN] }), ORIGIN.spec, doc as never))
		await expect(run.originClients.get("other")?.client.get("/notes", AS_ALPHA)).rejects.toThrow(UnsatisfiedSecurity)
	})
})
