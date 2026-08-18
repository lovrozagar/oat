import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Client, type Exchange } from "../src/runtime/client.ts"
import {
	INLINE_BODY_LIMIT,
	createExchangeJournal,
	exchangeFileStem,
	isBinaryMediaType,
	isSecretHeaderName,
	primaryMediaType,
	redactHeaders,
	redactJson,
	resolveSaveExchanges,
	sanitizeExchangeId,
} from "../src/runtime/exchanges.ts"
import { renderMarkdown, type ReportInput } from "../src/report/render.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

function exchange(partial: Partial<Exchange> = {}): Exchange {
	return {
		at: 1_700_000_000_000,
		durationMs: 12,
		method: "GET",
		requestBody: undefined,
		requestBytes: 10,
		requestHeaders: {},
		requestId: "",
		responseBody: null,
		responseBytes: 20,
		responseHeaders: {},
		seq: 1,
		status: 200,
		url: "http://x.test/v1/things",
		...partial,
	}
}

async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "oat-ex-"))
}

describe("resolveSaveExchanges", () => {
	it("lets the CLI win, then config, then off only for cheap", () => {
		expect(resolveSaveExchanges({ flag: false, config: true, profile: "full" })).toBe(false)
		expect(resolveSaveExchanges({ flag: true, config: false, profile: "cheap" })).toBe(true)
		expect(resolveSaveExchanges({ config: false, profile: "full" })).toBe(false)
		expect(resolveSaveExchanges({ config: true, profile: "cheap" })).toBe(true)
		expect(resolveSaveExchanges({ profile: "cheap" })).toBe(false)
		expect(resolveSaveExchanges({ profile: "full" })).toBe(true)
		expect(resolveSaveExchanges({})).toBe(true)
	})
})

describe("redaction helpers", () => {
	it("redacts listed headers, x-*-key / x-*-secret, and JSON token fields", () => {
		expect(isSecretHeaderName("Authorization")).toBe(true)
		expect(isSecretHeaderName("cookie")).toBe(true)
		expect(isSecretHeaderName("Set-Cookie")).toBe(true)
		expect(isSecretHeaderName("Proxy-Authorization")).toBe(true)
		expect(isSecretHeaderName("x-ia-tester-key")).toBe(true)
		expect(isSecretHeaderName("x-api-key")).toBe(true)
		expect(isSecretHeaderName("X-Client-Secret")).toBe(true)
		expect(isSecretHeaderName("content-type")).toBe(false)
		expect(redactHeaders({ Authorization: "Bearer secret", Accept: "application/json" })).toEqual({
			Accept: "application/json",
			Authorization: "<redacted>",
		})
		expect(
			redactJson({
				access_token: "aaa.bbb.ccc",
				nested: { refresh_token: "r", keep: 1 },
				items: [{ password: "p", id_token: "i", token: "t", secret: "s", api_key: "k" }],
			}),
		).toEqual({
			access_token: "<redacted>",
			items: [
				{
					api_key: "<redacted>",
					id_token: "<redacted>",
					password: "<redacted>",
					secret: "<redacted>",
					token: "<redacted>",
				},
			],
			nested: { keep: 1, refresh_token: "<redacted>" },
		})
		expect(redactJson("plain")).toBe("plain")
	})
})

describe("file stems", () => {
	it("sanitizes ids and never reuses a taken name", () => {
		expect(sanitizeExchangeId("  abc/def:*?  ")).toBe("abc_def")
		expect(sanitizeExchangeId("___")).toBe("id")
		expect(sanitizeExchangeId("x".repeat(200)).length).toBe(180)
		expect(exchangeFileStem("", 3, new Set())).toBe("seq-3")
		expect(exchangeFileStem("req-1", 1, new Set())).toBe("req-1")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1"]))).toBe("req-1-8")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1", "req-1-8"]))).toBe("req-1-8-2")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1", "req-1-8", "req-1-8-2"]))).toBe("req-1-8-3")
	})
})

describe("isBinaryMediaType", () => {
	it("classifies downloads that must not be inlined as base64", () => {
		expect(isBinaryMediaType("image/jpeg")).toBe(true)
		expect(isBinaryMediaType("audio/mpeg")).toBe(true)
		expect(isBinaryMediaType("video/mp4")).toBe(true)
		expect(isBinaryMediaType("application/pdf")).toBe(true)
		expect(isBinaryMediaType("application/octet-stream")).toBe(true)
		expect(isBinaryMediaType("application/zip")).toBe(true)
		expect(isBinaryMediaType("application/vnd.ms-excel")).toBe(true)
		expect(isBinaryMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true)
		expect(isBinaryMediaType("application/vnd.oasis.opendocument.spreadsheet")).toBe(true)
		expect(isBinaryMediaType("application/json")).toBe(false)
		expect(isBinaryMediaType("text/plain; charset=utf-8")).toBe(false)
		expect(isBinaryMediaType("; application/pdf")).toBe(true)
		expect(primaryMediaType("application/json; charset=utf-8", "x")).toBe("application/json")
		expect(primaryMediaType(";", "text/plain")).toBe("text/plain")
		expect(primaryMediaType("", "text/plain")).toBe("text/plain")
	})
})

describe("exchange journal", () => {
	it("writes a JSON POST/GET that jsonl can join by requestId", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		expect(journal.dir).toBe(dir)
		await journal.record(
			exchange({
				fixture: "invoice.pdf",
				method: "POST",
				operationId: "thing.create",
				requestBody: { name: "n", access_token: "eyJhbGciOiJ" },
				requestHeaders: { authorization: "Bearer super-secret", "content-type": "application/json" },
				requestId: "req-json",
				responseBody: { id: "1", name: "n" },
				responseHeaders: { "content-type": "application/json", "x-request-id": "req-json" },
				seq: 1,
				status: 201,
				url: "http://x.test/v1/things",
			}),
			{ check: "effects.declared-effect-occurs", entity: "thing", phase: "test" },
		)
		await journal.record(
			exchange({
				method: "GET",
				operationId: "thing.read",
				requestId: "req-get",
				responseBody: { id: "1" },
				responseHeaders: { "content-type": "application/json" },
				seq: 2,
				url: "http://x.test/v1/things/1",
			}),
		)
		expect(journal.count).toBe(2)
		const jsonl = (await readFile(join(dir, "exchanges.jsonl"), "utf8")).trim().split("\n")
		const first = JSON.parse(jsonl[0] ?? "{}") as Record<string, unknown>
		expect(first.requestId).toBe("req-json")
		expect(first.file).toBe("exchanges/req-json.json")
		expect(first.check).toBe("effects.declared-effect-occurs")
		expect(first.entity).toBe("thing")
		expect(first.phase).toBe("test")
		expect(first.fixture).toBe("invoice.pdf")
		expect(first.operationId).toBe("thing.create")
		const file = JSON.parse(await readFile(join(dir, "exchanges/req-json.json"), "utf8")) as {
			requestHeaders: Record<string, string>
			requestBody: Record<string, unknown>
			status: number
		}
		expect(file.status).toBe(201)
		expect(file.requestHeaders.authorization).toBe("<redacted>")
		expect(file.requestBody.access_token).toBe("<redacted>")
		expect(file.requestBody.name).toBe("n")
		const disk = await readFile(join(dir, "exchanges/req-json.json"), "utf8")
		expect(disk).not.toMatch(/Bearer super-secret/)
		expect(disk).not.toContain("eyJhbGciOiJ")
		expect(existsSync(join(dir, "exchanges/req-get.json"))).toBe(true)
	})

	it("content-addresses the same multipart fixture across two POSTs", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03])
		const once = async (seq: number, requestId: string): Promise<void> => {
			const form = new FormData()
			form.append("title", "scan")
			form.append("password", "nope")
			form.append("file", new File([bytes], "photo.jpg", { type: "image/jpeg" }))
			await journal.record(
				exchange({
					method: "POST",
					requestBody: form,
					requestId,
					seq,
					url: "http://x.test/v1/upload",
				}),
			)
		}
		await once(1, "up-1")
		await once(2, "up-2")
		const blobs = await readdir(join(dir, "blobs"))
		expect(blobs).toHaveLength(1)
		const one = JSON.parse(await readFile(join(dir, "exchanges/up-1.json"), "utf8")) as {
			requestBody: { parts: Array<Record<string, unknown>> }
		}
		const two = JSON.parse(await readFile(join(dir, "exchanges/up-2.json"), "utf8")) as {
			requestBody: { parts: Array<Record<string, unknown>> }
		}
		expect(one.requestBody.parts[2]).toMatchObject({
			bytes: 6,
			field: "file",
			filename: "photo.jpg",
			mediaType: "image/jpeg",
			sha256: blobs[0],
		})
		expect(one.requestBody.parts[2]?.sha256).toBe(two.requestBody.parts[2]?.sha256)
		expect(one.requestBody.parts[1]).toEqual({ field: "password", value: "<redacted>" })
		expect(JSON.stringify(one)).not.toContain("ÿ")
		const stored = await readFile(join(dir, "blobs", blobs[0] ?? ""))
		expect([...stored]).toEqual([...bytes])
	})

	it("names a missing request id seq-<n>.json and does not overwrite a duplicate id", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(exchange({ requestId: "", seq: 4, url: "http://x.test/a" }))
		await journal.record(exchange({ requestId: "same", seq: 5, url: "http://x.test/b" }))
		await journal.record(exchange({ requestId: "same", seq: 6, url: "http://x.test/c" }))
		expect(existsSync(join(dir, "exchanges/seq-4.json"))).toBe(true)
		expect(existsSync(join(dir, "exchanges/same.json"))).toBe(true)
		expect(existsSync(join(dir, "exchanges/same-6.json"))).toBe(true)
		const first = JSON.parse(await readFile(join(dir, "exchanges/same.json"), "utf8")) as { url: string }
		const second = JSON.parse(await readFile(join(dir, "exchanges/same-6.json"), "utf8")) as { url: string }
		expect(first.url).toBe("http://x.test/b")
		expect(second.url).toBe("http://x.test/c")
		const lines = (await readFile(join(dir, "exchanges.jsonl"), "utf8")).trim().split("\n")
		expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({ file: "exchanges/same-6.json", requestId: "same" })
	})

	it("does not clobber a stem that already exists on disk", async () => {
		const dir = await scratch()
		await mkdir(join(dir, "exchanges"), { recursive: true })
		await writeFile(join(dir, "exchanges/pre.json"), '{"keep":true}\n')
		const journal = createExchangeJournal(dir)
		await journal.record(exchange({ requestId: "pre", seq: 9 }))
		expect(JSON.parse(await readFile(join(dir, "exchanges/pre.json"), "utf8"))).toEqual({ keep: true })
		expect(existsSync(join(dir, "exchanges/pre-9.json"))).toBe(true)
		await writeFile(join(dir, "exchanges/dup.json"), "{}\n")
		await writeFile(join(dir, "exchanges/dup-3.json"), "{}\n")
		await journal.record(exchange({ requestId: "dup", seq: 3 }))
		expect(existsSync(join(dir, "exchanges/dup-3-2.json"))).toBe(true)
	})

	it("stores SSE as parsed frames, not a raw dump", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(
			exchange({
				requestId: "sse-1",
				responseBody: 'event: batch\ndata: {"access_token":"nope","n":1}\n\n',
				responseHeaders: { "content-type": "text/event-stream" },
				seq: 1,
			}),
		)
		const file = JSON.parse(await readFile(join(dir, "exchanges/sse-1.json"), "utf8")) as {
			responseBody: Array<{ event: string; data: Record<string, unknown> }>
		}
		expect(file.responseBody).toEqual([{ data: { access_token: "<redacted>", n: 1 }, event: "batch" }])
		expect(JSON.stringify(file)).not.toContain("nope")
	})

	it("keeps an event-stream body as text when it is not framed", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(
			exchange({
				requestId: "sse-raw",
				responseBody: "not a frame",
				responseHeaders: { "content-type": "text/event-stream" },
				seq: 1,
			}),
		)
		const file = JSON.parse(await readFile(join(dir, "exchanges/sse-raw.json"), "utf8")) as { responseBody: unknown }
		expect(file.responseBody).toBe("not a frame")
	})

	it("parses SSE frames from a raw string even without the event-stream header", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(
			exchange({
				requestId: "sse-guess",
				responseBody: 'data: {"ok":true}\n\n',
				responseHeaders: { "content-type": "text/plain" },
				seq: 1,
			}),
		)
		const file = JSON.parse(await readFile(join(dir, "exchanges/sse-guess.json"), "utf8")) as { responseBody: unknown }
		expect(file.responseBody).toEqual([{ data: { ok: true }, event: "message" }])
	})

	it("spills oversized text and JSON to blobs/", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		const big = "z".repeat(INLINE_BODY_LIMIT + 8)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: big,
				requestId: "big-text",
				responseBody: { blob: "w".repeat(INLINE_BODY_LIMIT + 8) },
				responseHeaders: { "content-type": "application/json" },
				seq: 1,
			}),
		)
		const file = JSON.parse(await readFile(join(dir, "exchanges/big-text.json"), "utf8")) as {
			requestBody: { sha256: string; bytes: number; mediaType: string }
			responseBody: { sha256: string; bytes: number; mediaType: string }
		}
		expect(file.requestBody.bytes).toBeGreaterThan(INLINE_BODY_LIMIT)
		expect(file.requestBody.mediaType).toBe("text/plain")
		expect(file.responseBody.mediaType).toBe("application/json")
		expect(existsSync(join(dir, "blobs", file.requestBody.sha256))).toBe(true)
		expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
	})

	it("stores binary downloads as a blob pointer", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(
			exchange({
				requestId: "pdf",
				responseBody: "%PDF-1.4 fake",
				responseHeaders: { "content-type": "application/pdf" },
				seq: 1,
			}),
		)
		await journal.record(
			exchange({
				requestId: "pdf-obj",
				responseBody: { note: "not-bytes" },
				responseHeaders: { "content-type": "application/pdf" },
				seq: 2,
			}),
		)
		const file = JSON.parse(await readFile(join(dir, "exchanges/pdf.json"), "utf8")) as {
			responseBody: { sha256: string; mediaType: string }
		}
		expect(file.responseBody.mediaType).toBe("application/pdf")
		expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
		expect(JSON.stringify(file)).not.toMatch(/JVBER/)
	})

	it("hashes raw request bytes and URLSearchParams", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: new Uint8Array([1, 2, 3]),
				requestId: "bin",
				seq: 1,
			}),
		)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: new ArrayBuffer(4),
				requestId: "ab",
				seq: 2,
			}),
		)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: new DataView(new ArrayBuffer(2)),
				requestId: "view",
				seq: 3,
			}),
		)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: new Blob([new Uint8Array([9])]),
				requestId: "blob",
				seq: 4,
			}),
		)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: new URLSearchParams({ a: "1", token: "secret" }),
				requestId: "qs",
				seq: 5,
			}),
		)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: 7,
				requestId: "num",
				responseBody: undefined,
				seq: 6,
			}),
		)
		await journal.record(
			exchange({
				requestId: "sse-obj",
				responseBody: { already: "json" },
				responseHeaders: { "content-type": "text/event-stream" },
				seq: 7,
			}),
		)
		const qs = JSON.parse(await readFile(join(dir, "exchanges/qs.json"), "utf8")) as {
			requestBody: Record<string, unknown>
		}
		expect(qs.requestBody.token).toBe("<redacted>")
		expect(qs.requestBody.a).toBe("1")
		const bin = JSON.parse(await readFile(join(dir, "exchanges/bin.json"), "utf8")) as {
			requestBody: { sha256: string; bytes: number }
		}
		expect(bin.requestBody.bytes).toBe(3)
		expect(existsSync(join(dir, "blobs", bin.requestBody.sha256))).toBe(true)
		const num = JSON.parse(await readFile(join(dir, "exchanges/num.json"), "utf8")) as { requestBody: unknown }
		expect(num.requestBody).toBe(7)

		const raw = new Uint8Array([9, 8, 7])
		const digest = createHash("sha256").update(raw).digest("hex")
		await mkdir(join(dir, "blobs"), { recursive: true })
		await writeFile(join(dir, "blobs", digest), raw)
		await journal.record(
			exchange({
				method: "POST",
				requestBody: raw,
				requestId: "reuse-blob",
				responseBody: 3,
				responseHeaders: { "content-type": "application/octet-stream" },
				seq: 8,
			}),
		)
		const reused = JSON.parse(await readFile(join(dir, "exchanges/reuse-blob.json"), "utf8")) as {
			requestBody: { sha256: string }
			responseBody: { sha256: string }
		}
		expect(reused.requestBody.sha256).toBe(digest)
		expect(reused.responseBody.sha256).toBeDefined()

		const emptyType = new FormData()
		emptyType.append("file", new File([new Uint8Array([1])], "a.bin"))
		await journal.record(exchange({ method: "POST", requestBody: emptyType, requestId: "empty-type", seq: 9 }))
		const empty = JSON.parse(await readFile(join(dir, "exchanges/empty-type.json"), "utf8")) as {
			requestBody: { parts: Array<Record<string, unknown>> }
		}
		expect(empty.requestBody.parts[0]?.mediaType).toBe("application/octet-stream")

		const formText = new FormData()
		formText.append("note", "hi")
		await journal.record(exchange({ method: "POST", requestBody: formText, requestId: "form-text", seq: 10 }))

		await journal.record(
			exchange({
				requestId: "sse-case",
				responseBody: "hello-stream",
				responseHeaders: { "content-type": "; TEXT/EVENT-STREAM" },
				seq: 11,
			}),
		)
		const sseCase = JSON.parse(await readFile(join(dir, "exchanges/sse-case.json"), "utf8")) as {
			responseBody: unknown
		}
		expect(sseCase.responseBody).toBe("hello-stream")

		await journal.record(
			exchange({
				requestId: "pdf-bytes",
				responseBody: new Uint8Array([37, 80, 68, 70]),
				responseHeaders: { "content-type": "application/pdf" },
				seq: 12,
			}),
		)
		expect(
			(
				JSON.parse(await readFile(join(dir, "exchanges/pdf-bytes.json"), "utf8")) as {
					responseBody: { mediaType: string }
				}
			).responseBody.mediaType,
		).toBe("application/pdf")

		await journal.record(exchange({ requestId: "scalar-res", responseBody: 0, seq: 13 }))

		const hugeStream = "x".repeat(INLINE_BODY_LIMIT + 4)
		await journal.record(
			exchange({
				requestId: "sse-huge",
				responseBody: hugeStream,
				responseHeaders: { "content-type": "text/event-stream" },
				seq: 14,
			}),
		)
		const spilled = JSON.parse(await readFile(join(dir, "exchanges/sse-huge.json"), "utf8")) as {
			responseBody: { sha256: string; mediaType: string }
		}
		expect(spilled.responseBody.mediaType).toBe("text/event-stream")

		await journal.record(
			exchange({
				requestId: "plain-text",
				responseBody: "hello",
				responseHeaders: { "content-type": "text/plain" },
				seq: 15,
			}),
		)
		expect(
			(JSON.parse(await readFile(join(dir, "exchanges/plain-text.json"), "utf8")) as { responseBody: unknown })
				.responseBody,
		).toBe("hello")

		await journal.record(
			exchange({
				requestId: "no-type",
				responseBody: { ok: true },
				seq: 16,
			}),
		)
		expect(
			(JSON.parse(await readFile(join(dir, "exchanges/no-type.json"), "utf8")) as { responseBody: { ok: boolean } })
				.responseBody.ok,
		).toBe(true)
	})

	it("flushes from Client.onExchange and skips the dir when save is off", async () => {
		const spec: OpenApiDocument = {
			info: { title: "j", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/widgets": {
					get: {
						operationId: "widget.list",
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: {
												widgets: {
													items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
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
						"x-entity": { action: "list", identity: "id", name: "widget" },
					},
					post: {
						operationId: "widget.create",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
								},
							},
							required: true,
						},
						responses: {
							"201": {
								content: {
									"application/json": {
										schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
									},
								},
								description: "created",
							},
						},
						"x-entity": { action: "create", identity: "id", name: "widget" },
					},
				},
				"/v1/widgets/{widget_id}": {
					delete: {
						operationId: "widget.delete",
						parameters: [{ in: "path", name: "widget_id", required: true, schema: { type: "string" } }],
						responses: { "204": { description: "gone" } },
						"x-entity": { action: "delete", identity: "id", name: "widget" },
					},
					get: {
						operationId: "widget.read",
						parameters: [{ in: "path", name: "widget_id", required: true, schema: { type: "string" } }],
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "read", identity: "id", name: "widget" },
					},
				},
			},
		}

		const widgets = new Map<string, { id: string; name: string }>()
		let seq = 0
		const server = createServer((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const write = (status: number, body?: unknown): void => {
					if (body === undefined) {
						res.writeHead(status)
						res.end()
						return
					}
					const text = JSON.stringify(body)
					res.writeHead(status, {
						"content-length": String(Buffer.byteLength(text)),
						"content-type": "application/json",
						"x-request-id": `wid-${String(seq + 1)}`,
					})
					res.end(text)
				}
				if (url.pathname === "/v1/openapi/spec") return write(200, spec)
				if (url.pathname === "/v1/widgets" && method === "GET") return write(200, { widgets: [...widgets.values()] })
				if (url.pathname === "/v1/widgets" && method === "POST") {
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
					const id = `w_${String((seq += 1))}`
					const row = { id, name: body.name ?? "n" }
					widgets.set(id, row)
					return write(201, row)
				}
				const item = /^\/v1\/widgets\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					const row = widgets.get(item[1] ?? "")
					return row === undefined ? write(404) : write(200, row)
				}
				if (item !== null && method === "DELETE") {
					widgets.delete(item[1] ?? "")
					return write(204)
				}
				return write(404)
			})().catch(() => {
				res.writeHead(500)
				res.end()
			})
		})
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve)
		})
		closers.push(
			() =>
				new Promise((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()))
				}),
		)
		const addr = server.address()
		if (addr === null || typeof addr === "string") throw new Error("no addr")
		const url = `http://127.0.0.1:${addr.port}`
		const on = await scratch()
		const saved = await run({
			baseUrl: url,
			cohortSize: 1,
			exchangeDir: on,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a" }],
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(saved.exchanges?.count).toBeGreaterThan(0)
		expect(existsSync(join(on, "exchanges.jsonl"))).toBe(true)
		expect(existsSync(join(on, "exchanges"))).toBe(true)
		const listing = await readdir(join(on, "exchanges"))
		expect(listing.length).toBe(saved.exchanges?.count)

		const off = await scratch()
		const skipped = await run({
			baseUrl: url,
			cohortSize: 1,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a" }],
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(skipped.exchanges).toBeUndefined()
		expect(existsSync(join(off, "exchanges"))).toBe(false)
	})
})

describe("report line", () => {
	it("names the exchanges directory and count", () => {
		const md = renderMarkdown({
			baseUrl: "http://x.test",
			checksRun: ["list.read-after-write"],
			client: { transcript: [] },
			durationMs: 1,
			entitiesTested: ["widget"],
			exchanges: { count: 1841 },
			findings: [],
			model: { entities: new Map(), operations: [] },
			startedAt: new Date("2026-08-18T00:00:00.000Z"),
		} as unknown as ReportInput)
		expect(md).toContain("**Exchanges**: 1841 → [exchanges/](./exchanges/)")
	})
})

describe("Client records operationId and fixture on the exchange", () => {
	it("copies them through for the journal", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json", "x-request-id": "from-server" })
			res.end("{}")
		})
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve)
		})
		closers.push(
			() =>
				new Promise((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()))
				}),
		)
		const addr = server.address()
		if (addr === null || typeof addr === "string") throw new Error("no addr")
		const seen: Exchange[] = []
		const client = new Client(`http://127.0.0.1:${addr.port}`, {}, 4, (item) => {
			seen.push(item)
		})
		const exchange = await client.get("/v1/x", { fixture: "a.pdf", operationId: "x.read" })
		expect(exchange.operationId).toBe("x.read")
		expect(exchange.fixture).toBe("a.pdf")
		expect(exchange.requestId).toBe("from-server")
		expect(seen).toHaveLength(1)
	})
})
