import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { encodeRequest, isFilePart } from "../src/runtime/body.ts"
import { Client } from "../src/runtime/client.ts"
import { dummyFile } from "../src/runtime/dummy.ts"
import { resetUploadPool } from "../src/runtime/upload.ts"
import { requestContent, requestSchema } from "../src/spec/collection.ts"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument, OperationObject } from "../src/spec/types.ts"

afterEach(() => {
	resetUploadPool()
})

const MULTIPART_EXTRACT: OperationObject = {
	operationId: "extract.once",
	requestBody: {
		content: {
			"application/json": {
				schema: { properties: { text: { type: "string" } }, type: "object" },
			},
			"multipart/form-data": {
				schema: {
					properties: {
						file: { contentMediaType: "application/pdf", format: "binary", type: "string" },
						text: { type: "string" },
					},
					required: ["file", "text"],
					type: "object",
				},
			},
		},
		required: true,
	},
	responses: { "200": { description: "ok" } },
}

const JSON_CREATE: OperationObject = {
	operationId: "table.create",
	requestBody: {
		content: {
			"application/json": {
				schema: {
					properties: { name: { type: "string" } },
					required: ["name"],
					type: "object",
				},
			},
		},
		required: true,
	},
	responses: { "201": { description: "ok" } },
}

const URLENCODED_LOGIN: OperationObject = {
	operationId: "auth.login",
	requestBody: {
		content: {
			"application/x-www-form-urlencoded": {
				schema: {
					properties: { password: { type: "string" }, username: { type: "string" } },
					required: ["username", "password"],
					type: "object",
				},
			},
		},
		required: true,
	},
	responses: { "200": { description: "ok" } },
}

describe("request media selection", () => {
	it("prefers multipart when JSON is also listed", () => {
		const picked = requestContent(MULTIPART_EXTRACT)
		expect(picked?.mediaType).toBe("multipart/form-data")
		expect(requestSchema(MULTIPART_EXTRACT)?.properties).toHaveProperty("file")
	})

	it("sees urlencoded as a request body", () => {
		const picked = requestContent(URLENCODED_LOGIN)
		expect(picked?.mediaType).toBe("application/x-www-form-urlencoded")
	})

	it("treats format:binary as a file part", () => {
		expect(isFilePart({ format: "binary", type: "string" })).toBe(true)
		expect(isFilePart({ contentMediaType: "application/pdf", type: "string" })).toBe(true)
		expect(isFilePart({ type: "string" })).toBe(false)
	})
})

describe("dummy files", () => {
	it("emits sniffable PDF magic", () => {
		const file = dummyFile({
			contentMediaType: "application/pdf",
			field: "file",
			index: 0,
			seed: 1,
			variant: "baseline",
		})
		expect(file.filename).toBe("file-baseline-0.pdf")
		expect(file.mediaType).toBe("application/pdf")
		expect(Buffer.from(file.bytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-")
		expect(Buffer.from(file.bytes).toString("ascii")).toContain("%%EOF")
	})
})

describe("encode + client", () => {
	it("sends multipart FormData with a dummy PDF and no JSON content-type", async () => {
		const { close, last, url } = await serveEcho()
		try {
			const encoded = await encodeRequest({
				fields: { text: "invoice text" },
				index: 0,
				mediaType: "multipart/form-data",
				operationId: "extract.once",
				schema: MULTIPART_EXTRACT.requestBody?.content?.["multipart/form-data"]?.schema ?? {},
				uploads: { seed: 7 },
				variant: "baseline",
			})
			expect(encoded.body).toBeInstanceOf(FormData)
			expect(encoded.contentType).toBeNull()

			const client = new Client(url)
			const exchange = await client.request("POST", "/extract", {
				body: encoded.body,
				contentType: encoded.contentType,
			})

			expect(exchange.requestBody).toBeInstanceOf(FormData)
			expect(exchange.requestHeaders["content-type"]).toBeUndefined()
			const file = (exchange.requestBody as FormData).get("file")
			expect(file).toBeInstanceOf(File)
			expect((file as File).size).toBeGreaterThan(0)
			const bytes = new Uint8Array(await (file as File).arrayBuffer())
			expect(Buffer.from(bytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-")

			expect(last().contentType).toMatch(/^multipart\/form-data;/)
			expect(last().contentType).not.toContain("application/json")
			expect(last().parts).toContain("file")
			expect(last().parts).toContain("text")
			expect(last().fileBytes?.subarray(0, 5)).toEqual(Buffer.from("%PDF-"))
		} finally {
			await close()
		}
	})

	it("sends pool file bytes when the extension matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-pool-"))
		const fixture = join(dir, "fixture.pdf")
		const poolBytes = Buffer.from("%PDF-1.1\npool-marker\n%%EOF\n")
		await writeFile(fixture, poolBytes)

		const encoded = await encodeRequest({
			fields: { text: "x" },
			index: 0,
			mediaType: "multipart/form-data",
			operationId: "extract.once",
			schema: MULTIPART_EXTRACT.requestBody?.content?.["multipart/form-data"]?.schema ?? {},
			uploads: { configDir: dir, seed: 3, uploads: { pool: ["./fixture.pdf"] } },
			variant: "baseline",
		})
		const file = (encoded.body as FormData).get("file") as File
		const sent = new Uint8Array(await file.arrayBuffer())
		expect(Buffer.from(sent).toString("ascii")).toContain("pool-marker")
	})

	it("lets resolveUpload win over pool and dummy", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-pool-"))
		await writeFile(join(dir, "fixture.pdf"), "%PDF-1.1\npool\n%%EOF\n")
		const hookBytes = new Uint8Array(Buffer.from("%PDF-1.1\nhook-wins\n%%EOF\n"))

		const encoded = await encodeRequest({
			fields: { text: "x" },
			index: 0,
			mediaType: "multipart/form-data",
			operationId: "extract.once",
			schema: MULTIPART_EXTRACT.requestBody?.content?.["multipart/form-data"]?.schema ?? {},
			uploads: {
				configDir: dir,
				resolveUpload: async ({ field }) => {
					if (field === "file") {
						return { bytes: hookBytes, filename: "known.pdf", mediaType: "application/pdf" }
					}
					return null
				},
				seed: 3,
				uploads: { pool: ["./fixture.pdf"] },
			},
			variant: "baseline",
		})
		const file = (encoded.body as FormData).get("file") as File
		expect(Buffer.from(await file.arrayBuffer()).toString("ascii")).toContain("hook-wins")
		expect(file.name).toBe("known.pdf")
	})

	it("falls through to a dummy when resolveUpload returns null and the pool is empty", async () => {
		const encoded = await encodeRequest({
			fields: { text: "x" },
			index: 2,
			mediaType: "multipart/form-data",
			operationId: "extract.once",
			schema: MULTIPART_EXTRACT.requestBody?.content?.["multipart/form-data"]?.schema ?? {},
			uploads: {
				resolveUpload: async () => null,
				seed: 11,
				uploads: { pool: [] },
			},
			variant: "unicode",
		})
		expect(encoded.body).toBeInstanceOf(FormData)
		const file = (encoded.body as FormData).get("file") as File
		expect(file.size).toBeGreaterThan(0)
		expect(file.name).toBe("file-unicode-2.pdf")
		expect(
			Buffer.from(await file.arrayBuffer())
				.toString("ascii")
				.startsWith("%PDF-"),
		).toBe(true)
	})

	it("keeps a JSON-only create as JSON", async () => {
		const { close, last, url } = await serveEcho()
		try {
			const encoded = await encodeRequest({
				fields: { name: "Quarterly Report 0" },
				index: 0,
				mediaType: "application/json",
				operationId: "table.create",
				schema: JSON_CREATE.requestBody?.content?.["application/json"]?.schema ?? {},
				uploads: { seed: 1 },
				variant: "baseline",
			})
			expect(encoded.body).toEqual({ name: "Quarterly Report 0" })
			expect(encoded.body).not.toBeInstanceOf(FormData)

			const client = new Client(url)
			await client.request("POST", "/tables", {
				body: encoded.body,
				...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
			})
			expect(last().contentType).toContain("application/json")
			expect(last().json).toEqual({ name: "Quarterly Report 0" })
		} finally {
			await close()
		}
	})

	it("sends urlencoded login, not JSON", async () => {
		const { close, last, url } = await serveEcho()
		try {
			const encoded = await encodeRequest({
				fields: { password: "s3cret", username: "oat" },
				index: 0,
				mediaType: "application/x-www-form-urlencoded",
				operationId: "auth.login",
				schema: URLENCODED_LOGIN.requestBody?.content?.["application/x-www-form-urlencoded"]?.schema ?? {},
				uploads: { seed: 1 },
				variant: "baseline",
			})
			expect(encoded.body).toBeInstanceOf(URLSearchParams)
			expect(encoded.contentType).toBe("application/x-www-form-urlencoded")

			const client = new Client(url)
			const exchange = await client.request("POST", "/login", {
				body: encoded.body,
				contentType: encoded.contentType,
			})
			expect(exchange.requestBody).toBeInstanceOf(URLSearchParams)
			expect(exchange.requestHeaders["content-type"]).toBe("application/x-www-form-urlencoded")
			expect(last().contentType).toContain("application/x-www-form-urlencoded")
			expect(last().raw).toContain("username=oat")
			expect(last().json).toBeUndefined()
		} finally {
			await close()
		}
	})

	it("marks multipart-only operations as having a request body", () => {
		const model = buildModel({
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/extract": {
					post: {
						...MULTIPART_EXTRACT,
						"x-entity": { action: "action", identity: "id", name: "extract" },
					},
				},
			},
		} as OpenApiDocument)
		expect(model.byOperationId.get("extract.once")?.hasRequestBody).toBe(true)
	})
})

interface Echo {
	contentType: string
	parts: string[]
	fileBytes?: Buffer
	json?: unknown
	raw: string
}

async function serveEcho(): Promise<{ close: () => Promise<void>; last: () => Echo; url: string }> {
	let last: Echo = { contentType: "", parts: [], raw: "" }
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks)
			const contentType = String(req.headers["content-type"] ?? "")
			const echo: Echo = { contentType, parts: partNames(raw), raw: raw.toString("latin1") }
			if (contentType.includes("application/json")) {
				try {
					echo.json = JSON.parse(raw.toString("utf8")) as unknown
				} catch {
					/* leave json unset */
				}
			}
			if (contentType.includes("multipart/")) {
				const file = filePartBytes(raw)
				if (file !== undefined) echo.fileBytes = file
			}
			last = echo
			const body = JSON.stringify({
				contentType,
				filePresent: echo.parts.includes("file"),
				parts: echo.parts,
			})
			res.writeHead(200, { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json" })
			res.end(body)
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
		last: () => last,
		url: `http://127.0.0.1:${address.port}`,
	}
}

function partNames(raw: Buffer): string[] {
	const names: string[] = []
	const text = raw.toString("latin1")
	const re = /name="([^"]+)"/g
	let match: RegExpExecArray | null
	while ((match = re.exec(text)) !== null) {
		if (match[1] !== undefined) names.push(match[1])
	}
	return [...new Set(names)]
}

function filePartBytes(raw: Buffer): Buffer | undefined {
	const text = raw.toString("latin1")
	const marker = /name="file"[^\r\n]*\r\n(?:[^\r\n]+:[^\r\n]*\r\n)*\r\n/
	const start = marker.exec(text)
	if (start === null || start.index === undefined) return undefined
	const from = start.index + start[0].length
	const rest = text.slice(from)
	const end = rest.search(/\r\n--/)
	const slice = end < 0 ? rest : rest.slice(0, end)
	return Buffer.from(slice, "latin1")
}
