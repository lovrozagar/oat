import { writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { EXIT, exitCode } from "../../src/runtime/exit.ts"
import { run } from "../../src/runtime/run/index.ts"
import { Ledger } from "../../src/runtime/teardown/ledger.ts"
import type { Disposable } from "../../src/runtime/teardown/types.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { latestReport, oat, tempDirs } from "../support/cli-run.ts"

/*
 * The run result names every record oat ledgered for teardown and whether it is gone. Counts alone
 * cannot say which id oat meant to remove, and the conformance suite needs exactly that to prove
 * every recorded id is one the backend created. A record teardown could not show gone fails the run
 * with exit 4, whatever else it found.
 */

type Note = { id: string; name: string }

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})
const dirs = tempDirs("oat-teardown-records-")
afterAll(dirs.removeAll)

const REFUSED = "note-1"

function spec(): OpenApiDocument {
	const note = {
		properties: { id: { readOnly: true, type: "string" }, name: { minLength: 1, type: "string" } },
		required: ["name"],
		type: "object",
	}
	const one = { content: { "application/json": { schema: note } }, description: "ok" }
	const idParam = [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }]
	return {
		info: { title: "teardown-records", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": { content: { "application/json": { schema: { items: note, type: "array" } } }, description: "ok" },
					},
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: { "201": one, "400": { description: "invalid" } },
				},
			},
			"/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: idParam,
					responses: {
						"204": { description: "gone" },
						"403": { description: "refused" },
						"404": { description: "missing" },
					},
				},
				get: {
					operationId: "note.get",
					parameters: idParam,
					responses: { "200": one, "404": { description: "missing" } },
				},
			},
		},
	} as OpenApiDocument
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	return raw === "" ? undefined : JSON.parse(raw)
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

/* The item path a request names, and its method. */
interface ItemRequest {
	pathname: string
	method: string
}

function noteItem(notes: Map<string, Note>, { method, pathname }: ItemRequest, res: ServerResponse): void {
	const id = decodeURIComponent(pathname.match(/^\/notes\/([^/]+)$/)?.[1] ?? "")
	const note = notes.get(id)
	if (method === "GET") return note === undefined ? send(res, 404, { error: "missing" }) : send(res, 200, note)
	if (method !== "DELETE") return send(res, 405, {})
	if (id === REFUSED) return send(res, 403, { error: "kept" })
	return notes.delete(id) ? send(res, 204) : send(res, 404, { error: "missing" })
}

/* Creates `note-1`, `note-2`, … in order and refuses to delete `note-1`. */
async function serve(notes: Map<string, Note>): Promise<string> {
	const document = spec()
	let next = 1
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			if (url.pathname === "/notes" && method === "GET") return send(res, 200, [...notes.values()])
			if (url.pathname === "/notes" && method === "POST") {
				const body = (await readJson(req)) as Partial<Note> | undefined
				if (typeof body?.name !== "string" || body.name === "") return send(res, 400, { error: "name" })
				const note = { id: `note-${next++}`, name: body.name }
				notes.set(note.id, note)
				return send(res, 201, note)
			}
			noteItem(notes, { method, pathname: url.pathname }, res)
		})().catch(() => {
			if (!res.headersSent) res.writeHead(500)
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

describe("teardown records", () => {
	it("lists every ledgered record in creation order, and whether it was removed", async () => {
		const notes = new Map<string, Note>()
		const url = await serve(notes)
		const result = await run({
			baseUrl: url,
			cohortSize: 3,
			principals: { alpha: {} },
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const records = result.teardown?.records ?? []
		expect(records.length).toBe(result.created)
		expect(records.every((record) => record.entity === "note")).toBe(true)
		const order = records.map((record) => Number(record.id.replace("note-", "")))
		expect(order).toEqual([...order].sort((a, b) => a - b))
		expect(records.find((record) => record.id === REFUSED)?.removed).toBe(false)
		expect(records.filter((record) => record.id !== REFUSED).every((record) => record.removed)).toBe(true)
		expect(records.filter((record) => record.removed).every((record) => !notes.has(record.id))).toBe(true)
	})
})

describe("a record teardown could not remove", () => {
	it("exits 4 on the CLI, naming the record in the console and the report", async () => {
		const url = await serve(new Map())
		const dir = await dirs.make()
		const config = join(dir, "oat.config.json")
		await writeFile(
			config,
			JSON.stringify({ baseUrl: url, cohortSize: 3, principals: { alpha: {} }, seed: 1, spec: `${url}/openapi.json` }),
		)
		const runs = join(dir, "runs")
		const { code, out } = await oat(["run", "--config", config, "--out", runs, "--quiet"])
		expect(code).toBe(EXIT.leftovers)
		expect(out).toMatch(/cleanup: removed (\d+)\/\d+ created record\(s\)/)
		expect(out).toContain(`note ${REFUSED} (as alpha)`)
		const report = await latestReport(runs)
		expect(report.outcome).toEqual({
			exitCode: EXIT.leftovers,
			reason: "records may remain: 1 teardown could not show gone",
			result: "leftovers",
		})
		expect(report.teardown?.failed).toEqual([expect.objectContaining({ entity: "note", id: REFUSED })])
		expect(report.teardown?.records.find((record) => record.id === REFUSED)?.removed).toBe(false)
	})

	it("exits 4 when teardown stops on an error, listing every record it was to remove", async () => {
		const url = await serve(new Map())
		/* Takes what is ledgered, as the real unwind does, then fails before removing any of it. */
		const unwind = vi.spyOn(Ledger.prototype, "unwind").mockImplementation(function (this: Ledger) {
			;(this.entries() as Disposable[]).splice(0)
			return Promise.reject(new Error("delete exploded"))
		})
		try {
			const result = await run({
				baseUrl: url,
				cohortSize: 3,
				principals: { alpha: {} },
				seed: 1,
				spec: `${url}/openapi.json`,
			})
			expect(result.findings.some((finding) => finding.check === "world.teardown")).toBe(true)
			expect(result.teardown?.failed.length).toBe(result.created)
			expect(result.teardown?.records.every((record) => !record.removed)).toBe(true)
			expect(exitCode(result)).toBe(EXIT.leftovers)
		} finally {
			unwind.mockRestore()
		}
	})
})
