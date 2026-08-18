import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { encodeRequest } from "../src/runtime/body.ts"
import { run } from "../src/runtime/run.ts"
import { resetUploadPool } from "../src/runtime/upload.ts"
import { forEachInvocation, resolveEachInvocations } from "../src/runtime/upload-each.ts"
import { seedCohort } from "../src/runtime/world.ts"
import { Client } from "../src/runtime/client.ts"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument, OperationObject } from "../src/spec/types.ts"

afterEach(() => {
	resetUploadPool()
})

const EXTRACT: OperationObject = {
	operationId: "extract.once",
	requestBody: {
		content: {
			"multipart/form-data": {
				schema: {
					properties: {
						columns: { type: "string" },
						file: { contentMediaType: "application/pdf", format: "binary", type: "string" },
					},
					required: ["file"],
					type: "object",
				},
			},
		},
		required: true,
	},
	responses: { "200": { description: "ok" }, "201": { description: "created" } },
	"x-entity": { action: "create", identity: "id", name: "extract" },
}

const LIST: OperationObject = {
	operationId: "extract.list",
	responses: {
		"200": {
			content: {
				"application/json": {
					schema: {
						properties: {
							extracts: {
								items: { properties: { id: { type: "string" } }, type: "object" },
								type: "array",
							},
						},
						type: "object",
					},
				},
			},
			description: "ok",
		},
	},
	"x-entity": { action: "list", identity: "id", name: "extract" },
}

const SCHEMA = EXTRACT.requestBody?.content?.["multipart/form-data"]?.schema ?? {}

async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "oat-each-"))
}

async function writePdf(dir: string, name: string, marker: string): Promise<string> {
	const path = join(dir, name)
	await writeFile(path, `%PDF-1.1\n${marker}\n%%EOF\n`)
	return path
}

describe("resolveEachInvocations", () => {
	it("returns null when the op is not in each", async () => {
		expect(await resolveEachInvocations("extract.once", { seed: 1, uploads: { pool: ["./x"] } })).toBeNull()
		expect(await resolveEachInvocations("extract.once", { seed: 1 })).toBeNull()
	})

	it("expands 3 files in sorted order", async () => {
		const dir = await scratch()
		await writePdf(dir, "c.pdf", "c")
		await writePdf(dir, "a.pdf", "a")
		await writePdf(dir, "b.pdf", "b")
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./*.pdf"] } },
		})
		expect(slots?.map((s) => s.filename)).toEqual(["a.pdf", "b.pdf", "c.pdf"])
		expect(slots?.[0]?.total).toBe(3)
		expect(slots?.[0]?.index).toBe(0)
	})

	it("warns once and returns [] for an empty glob", async () => {
		const dir = await scratch()
		const warnings: string[] = []
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./none/*.pdf"] } },
			warn: (message) => warnings.push(message),
		})
		expect(slots).toEqual([])
		expect(warnings.some((w) => w.includes("matched 0 files"))).toBe(true)
	})

	it("drops a missing path and keeps the rest without BACKEND_BUG", async () => {
		const dir = await scratch()
		await writePdf(dir, "keep-a.pdf", "a")
		await writePdf(dir, "keep-b.pdf", "b")
		const warnings: string[] = []
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./keep-a.pdf", "./missing.pdf", "./keep-b.pdf"] } },
			warn: (message) => warnings.push(message),
		})
		expect(slots?.map((s) => s.filename)).toEqual(["keep-a.pdf", "keep-b.pdf"])
		expect(warnings.some((w) => w.includes("path not found"))).toBe(true)
		expect(warnings.some((w) => w.includes("BACKEND"))).toBe(false)
	})

	it("ignores a negative eachMax", async () => {
		const dir = await scratch()
		await writePdf(dir, "a.pdf", "a")
		await writePdf(dir, "b.pdf", "b")
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./*.pdf"] }, eachMax: -1 },
		})
		expect(slots).toHaveLength(2)
	})

	it("caps at eachMax and warns", async () => {
		const dir = await scratch()
		for (const name of ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]) await writePdf(dir, name, name)
		const warnings: string[] = []
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./*.pdf"] }, eachMax: 2 },
			warn: (message) => warnings.push(message),
		})
		expect(slots).toHaveLength(2)
		expect(warnings.some((w) => w.includes("capped") && w.includes("2 of 5"))).toBe(true)
	})

	it("drops an unreadable path and warns", async () => {
		const dir = await scratch()
		await writePdf(dir, "ok.pdf", "ok")
		const bad = join(dir, "bad.pdf")
		await writeFile(bad, "secret")
		await chmod(bad, 0)
		const warnings: string[] = []
		try {
			const slots = await resolveEachInvocations("extract.once", {
				configDir: dir,
				seed: 1,
				uploads: { each: { "extract.once": ["./ok.pdf", "./bad.pdf"] } },
				warn: (message) => warnings.push(message),
			})
			expect(slots?.map((s) => s.filename)).toEqual(["ok.pdf"])
			expect(warnings.some((w) => w.includes("could not read"))).toBe(true)
		} finally {
			await chmod(bad, 0o644)
		}
	})

	it("dedupes the same file listed twice", async () => {
		const dir = await scratch()
		await writePdf(dir, "only.pdf", "one")
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./only.pdf", "./only.pdf"] } },
		})
		expect(slots).toHaveLength(1)
	})

	it("falls back to cwd when configDir is omitted", async () => {
		const slots = await resolveEachInvocations("extract.once", {
			seed: 1,
			uploads: { each: { "extract.once": ["./oat-each-no-such-dir-xyz/*.pdf"] } },
			warn: () => undefined,
		})
		expect(slots).toEqual([])
	})

	it("uses console.warn when no warn hook is set", async () => {
		const dir = await scratch()
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./gone/*.pdf"] } },
		})
		expect(slots).toEqual([])
	})
})

describe("forEachInvocation", () => {
	it("calls once with no slot when each is omitted", async () => {
		const seen: Array<string | undefined> = []
		await forEachInvocation(
			"other.op",
			{ seed: 1, uploads: { each: { "extract.once": ["./x"] } } },
			async (_u, slot) => {
				seen.push(slot?.filename)
			},
		)
		expect(seen).toEqual([undefined])
	})

	it("calls once per file when each matches", async () => {
		const dir = await scratch()
		await writePdf(dir, "one.pdf", "1")
		await writePdf(dir, "two.pdf", "2")
		const seen: string[] = []
		await forEachInvocation(
			"extract.once",
			{ configDir: dir, seed: 1, uploads: { each: { "extract.once": ["./*.pdf"] } } },
			async (_u, slot) => {
				if (slot !== undefined) seen.push(slot.filename)
			},
		)
		expect(seen).toEqual(["one.pdf", "two.pdf"])
	})
})

describe("encode fill order", () => {
	it("sends each fixture bytes when the hook returns scalar fields only", async () => {
		const dir = await scratch()
		await writePdf(dir, "invoice.pdf", "each-marker")
		const [slot] =
			(await resolveEachInvocations("extract.once", {
				configDir: dir,
				seed: 1,
				uploads: { each: { "extract.once": ["./invoice.pdf"] } },
			})) ?? []
		expect(slot).toBeDefined()
		const encoded = await encodeRequest({
			fields: {},
			index: 0,
			mediaType: "multipart/form-data",
			operationId: "extract.once",
			schema: SCHEMA,
			uploads: {
				configDir: dir,
				fixture: slot,
				resolveUpload: async () => ({ fields: { columns: "vendor,date,amount" } }),
				seed: 1,
				uploads: { each: { "extract.once": ["./invoice.pdf"] } },
			},
			variant: "baseline",
		})
		const form = encoded.body as FormData
		expect(form.get("columns")).toBe("vendor,date,amount")
		const file = form.get("file") as File
		expect(file.name).toBe("invoice.pdf")
		expect(Buffer.from(await file.arrayBuffer()).toString("ascii")).toContain("each-marker")
	})

	it("sends the hook file N times when resolveUpload ignores fixture", async () => {
		const dir = await scratch()
		await writePdf(dir, "a.pdf", "A")
		await writePdf(dir, "b.pdf", "B")
		const hookBytes = new Uint8Array(Buffer.from("%PDF-1.1\nhook-jpeg\n%%EOF\n"))
		const slots = await resolveEachInvocations("extract.once", {
			configDir: dir,
			seed: 1,
			uploads: { each: { "extract.once": ["./*.pdf"] } },
		})
		expect(slots).toHaveLength(2)
		const names: string[] = []
		const markers: string[] = []
		for (const slot of slots ?? []) {
			const encoded = await encodeRequest({
				fields: {},
				index: slot.index,
				mediaType: "multipart/form-data",
				operationId: "extract.once",
				schema: SCHEMA,
				uploads: {
					configDir: dir,
					fixture: slot,
					resolveUpload: async () => ({
						bytes: hookBytes,
						filename: "hardcoded.pdf",
						mediaType: "application/pdf",
					}),
					seed: 1,
					uploads: { each: { "extract.once": ["./*.pdf"] } },
				},
				variant: "baseline",
			})
			const file = (encoded.body as FormData).get("file") as File
			names.push(file.name)
			markers.push(Buffer.from(await file.arrayBuffer()).toString("ascii"))
		}
		expect(names).toEqual(["hardcoded.pdf", "hardcoded.pdf"])
		expect(markers.every((m) => m.includes("hook-jpeg"))).toBe(true)
	})

	it("uses a single pool pick when the op is not in each", async () => {
		const dir = await scratch()
		await writePdf(dir, "pool.pdf", "pool-only")
		await writePdf(dir, "other.pdf", "other")
		const encoded = await encodeRequest({
			fields: {},
			index: 0,
			mediaType: "multipart/form-data",
			operationId: "suggest.schema",
			schema: SCHEMA,
			uploads: {
				configDir: dir,
				seed: 4,
				uploads: { each: { "extract.once": ["./*.pdf"] }, pool: ["./pool.pdf"] },
			},
			variant: "baseline",
		})
		const file = (encoded.body as FormData).get("file") as File
		expect(Buffer.from(await file.arrayBuffer()).toString("ascii")).toContain("pool-only")
	})
})

describe("seed fan-out", () => {
	it("POSTs once per file with that filename on the wire", async () => {
		const dir = await scratch()
		await writePdf(dir, "one.pdf", "ONE")
		await writePdf(dir, "two.pdf", "TWO")
		await writePdf(dir, "three.pdf", "THREE")
		const seen: string[] = []
		const { close, url } = await serveExtract((name) => seen.push(name))
		try {
			const model = extractModel()
			const createOp = model.byOperationId.get("extract.once")
			if (createOp === undefined) throw new Error("missing extract.once")
			const client = new Client(url)
			const seeded = await seedCohort(
				createOp,
				model,
				client,
				{
					authHeaders: () => ({}),
					roots: {},
					seed: 1,
					uploads: {
						configDir: dir,
						seed: 1,
						uploads: { each: { "extract.once": ["./*.pdf"] } },
					},
				},
				{ created: [], values: {} },
			)
			expect(seeded.records).toHaveLength(3)
			expect(seen.sort()).toEqual(["one.pdf", "three.pdf", "two.pdf"])
		} finally {
			await close()
		}
	})
})

describe("profile skip", () => {
	it("does not POST an excluded each op", async () => {
		const dir = await scratch()
		await writePdf(dir, "one.pdf", "1")
		await writePdf(dir, "two.pdf", "2")
		const seen: string[] = []
		const { close, url } = await serveExtract((name) => seen.push(name), true)
		try {
			const result = await run({
				baseUrl: url,
				configDir: dir,
				principals: [{ headers: {}, id: "alpha" }],
				profile: "cheap",
				profiles: { cheap: { exclude: ["extract.once"] } },
				seed: 1,
				spec: `${url}/openapi.json`,
				uploads: { each: { "extract.once": ["./*.pdf"] } },
			})
			expect(seen).toEqual([])
			expect(result.findings.some((f) => f.check === "profile.skip")).toBe(true)
		} finally {
			await close()
		}
	})
})

function extractModel() {
	return buildModel({
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/extracts": { get: LIST, post: EXTRACT },
		},
	} as OpenApiDocument)
}

async function serveExtract(
	onFile: (name: string) => void,
	withSpec = false,
): Promise<{ close: () => Promise<void>; url: string }> {
	const spec = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/extracts": { get: LIST, post: EXTRACT },
			"/openapi.json": undefined,
		},
	}
	let seq = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (withSpec && url.pathname === "/openapi.json") {
				const body = JSON.stringify({
					info: spec.info,
					openapi: spec.openapi,
					paths: { "/extracts": { get: LIST, post: EXTRACT } },
				})
				res.writeHead(200, { "content-type": "application/json" })
				res.end(body)
				return
			}
			if ((req.method ?? "GET").toUpperCase() === "GET" && url.pathname === "/extracts") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ extracts: [] }))
				return
			}
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks).toString("latin1")
			const match = /filename="([^"]+)"/.exec(raw)
			if (match?.[1] !== undefined) onFile(match[1])
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ id: `ex_${String((seq += 1))}` }))
		})().catch(() => {
			if (!res.headersSent) res.writeHead(500)
			res.end()
		})
	})
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const address = server.address()
	if (address === null || typeof address === "string") throw new Error("no listen address")
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			}),
		url: `http://127.0.0.1:${address.port}`,
	}
}
