import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Client } from "../../client/client.ts"
import type { UploadRequest } from "../../config/types/hooks.ts"
import { Redactor } from "../../security/redact.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { bodiesModel, optionsOf, partsOf } from "./__fixtures__/options.ts"
import { encodeForOperation, encodeRequest, requestContentOf } from "./encode.ts"

const resolveInput = async (request: { field: string }): Promise<unknown> =>
	request.field === "name" ? "hooked" : null

function operation(operationId: string): OperationModel {
	const op = bodiesModel().byOperationId.get(operationId)
	if (op === undefined) throw new Error(`fixture has no ${operationId}`)
	return op
}

describe("requestContentOf", () => {
	it("is the body the operation documents, or null", () => {
		const model = bodiesModel()
		expect(requestContentOf(operation("docs.replace"), model)?.mediaType).toBe("application/json")
		expect(requestContentOf(operation("docs.list"), model)).toBeNull()
		expect(requestContentOf({ ...operation("docs.list"), operationId: "unknown" }, model)).toBeNull()
	})
})

describe("encodeRequest", () => {
	it("lets the input hook replace fields before encoding", async () => {
		const options = optionsOf({
			fields: { name: "n" },
			mediaType: "application/json",
			uploads: { resolveInput, seed: 1 },
		})
		expect(await encodeRequest(options)).toEqual({ body: { name: "hooked" }, contentType: undefined })
	})

	it("writes multipart as FormData, urlencoded as URLSearchParams, and anything else as the fields", async () => {
		const schema = { properties: { name: { type: "string" } }, type: "object" }
		const multipart = await encodeRequest(
			optionsOf({ fields: { name: "n", stray: "s" }, mediaType: "Multipart/Form-Data", schema }),
		)
		expect([partsOf(multipart.body as FormData), multipart.contentType]).toEqual([[["name", "n"]], null])
		const form = await encodeRequest(
			optionsOf({
				encoding: { tags: { explode: false } },
				fields: { tags: ["a", "b"] },
				mediaType: "application/x-www-form-urlencoded",
			}),
		)
		expect([(form.body as URLSearchParams).toString(), form.contentType]).toEqual([
			"tags=a%2Cb",
			"application/x-www-form-urlencoded",
		])
		expect(await encodeRequest(optionsOf({ fields: { a: 1 }, mediaType: "application/json" }))).toEqual({
			body: { a: 1 },
			contentType: undefined,
		})
	})
})

describe("encodeForOperation", () => {
	it("leaves the fields as they are for an operation without a body", async () => {
		const fields = { a: 1 }
		expect(await encodeForOperation(operation("docs.list"), bodiesModel(), { fields, uploads: { seed: 1 } })).toEqual({
			body: fields,
			contentType: undefined,
		})
	})

	it("encodes by the operation's media type and encoding, as the baseline's first record by default", async () => {
		const asked: UploadRequest[] = []
		const uploads = { resolveUpload: async (request: UploadRequest) => (asked.push(request), null), seed: 1 }
		const created = await encodeForOperation(operation("docs.create"), bodiesModel(), {
			fields: { tags: ["a", "b"] },
			uploads,
		})
		expect(partsOf(created.body as FormData).map(([name]) => name)).toEqual(["tags", "tags", "file"])
		expect(asked.map((request) => [request.variant, request.index])).toEqual([["baseline", 0]])
		await encodeForOperation(operation("docs.create"), bodiesModel(), {
			fields: {},
			index: 3,
			uploads,
			variant: "edge",
		})
		expect(asked.at(-1)).toMatchObject({ index: 3, variant: "edge" })
		const updated = await encodeForOperation(operation("docs.update"), bodiesModel(), {
			fields: { tags: ["a", "b"] },
			uploads,
		})
		expect((updated.body as URLSearchParams).toString()).toBe("tags=a%2Cb")
		const replaced = await encodeForOperation(operation("docs.replace"), bodiesModel(), {
			fields: { name: "n" },
			uploads,
		})
		expect(replaced).toEqual({ body: { name: "n" }, contentType: undefined })
	})
})

/* An extract that takes a PDF and a text as multipart, or the text alone as JSON. */
const EXTRACT_SCHEMA = {
	properties: {
		file: { contentMediaType: "application/pdf", format: "binary", type: "string" },
		text: { type: "string" },
	},
	required: ["file", "text"],
	type: "object",
}

type EncodeInput = Parameters<typeof encodeRequest>[0]

/* The extract operation's multipart body, `fields` defaulting to a text of "x". */
function encodeExtract(input: Pick<EncodeInput, "uploads"> & Partial<EncodeInput>) {
	return encodeRequest(
		optionsOf({ fields: { text: "x" }, operationId: "extract.once", schema: EXTRACT_SCHEMA, ...input }),
	)
}

/** What the wire carried, read back the way a server parses it. */
interface Echo {
	contentType: string
	parts: string[]
	fileBytes?: Buffer
	json?: unknown
	raw: string
}

/** A transport that serializes each request as fetch would and keeps the last one read back. */
function echoWire(): { fetchImpl: typeof fetch; last: () => Echo } {
	let last: Echo = { contentType: "", parts: [], raw: "" }
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		const raw = Buffer.from(await request.arrayBuffer())
		const contentType = request.headers.get("content-type") ?? ""
		last = { contentType, parts: partNames(raw), raw: raw.toString("latin1") }
		if (contentType.includes("application/json")) last.json = JSON.parse(raw.toString("utf8")) as unknown
		const file = contentType.includes("multipart/") ? filePartBytes(raw) : undefined
		if (file !== undefined) last.fileBytes = file
		return Response.json({ contentType, parts: last.parts })
	}
	return { fetchImpl: fetchImpl as typeof fetch, last: () => last }
}

function partNames(raw: Buffer): string[] {
	const names = [...raw.toString("latin1").matchAll(/name="([^"]+)"/g)].map((match) => match[1] ?? "")
	return [...new Set(names)]
}

function filePartBytes(raw: Buffer): Buffer | undefined {
	const text = raw.toString("latin1")
	const start = /name="file"[^\r\n]*\r\n(?:[^\r\n]+:[^\r\n]*\r\n)*\r\n/.exec(text)
	if (start === null) return undefined
	const rest = text.slice(start.index + start[0].length)
	const end = rest.search(/\r\n--/)
	return Buffer.from(end < 0 ? rest : rest.slice(0, end), "latin1")
}

/* One POST of an encoded body to `path`, by a fresh client over an echoing wire. */
async function postEncoded(path: string, encoded: Awaited<ReturnType<typeof encodeRequest>>) {
	const wire = echoWire()
	const client = new Client({
		baseUrl: "http://api.test",
		network: { fetchImpl: wire.fetchImpl },
		redactor: new Redactor(),
	})
	const exchange = await client.request("POST", path, {
		as: { anonymous: true },
		body: encoded.body,
		...(encoded.contentType === undefined ? {} : { contentType: encoded.contentType }),
	})
	return { client, exchange, last: wire.last }
}

describe("encodeRequest through the client, multipart", () => {
	it("sends multipart FormData with a dummy PDF and no JSON content-type", async () => {
		const encoded = await encodeExtract({ fields: { text: "invoice text" }, uploads: { seed: 7 } })
		expect(encoded.body).toBeInstanceOf(FormData)
		expect(encoded.contentType).toBeNull()
		const { client, exchange, last } = await postEncoded("/extract", encoded)
		expect(exchange.requestBody).toBeInstanceOf(FormData)
		expect(client.transcript.at(-1)?.requestBody).toMatchObject({
			parts: expect.arrayContaining([
				expect.objectContaining({ field: "text", value: "invoice text" }),
				expect.objectContaining({ field: "file", mediaType: "application/pdf" }),
			]),
		})
		expect(exchange.requestHeaders["content-type"]).toBeUndefined()
		const stored = (client.transcript.at(-1)?.requestBody ?? { parts: [] }) as {
			parts: Array<Record<string, unknown>>
		}
		const filePart = stored.parts.find((part) => part["field"] === "file")
		expect(filePart).toMatchObject({ field: "file", mediaType: "application/pdf" })
		expect(Number(filePart?.["bytes"])).toBeGreaterThan(0)
		expect(last().contentType).toMatch(/^multipart\/form-data;/)
		expect(last().contentType).not.toContain("application/json")
		expect(last().parts).toContain("file")
		expect(last().parts).toContain("text")
		expect(last().fileBytes?.subarray(0, 5)).toEqual(Buffer.from("%PDF-"))
	})
})

describe("encodeRequest, choosing the file", () => {
	it("sends pool file bytes when the extension matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-pool-"))
		await writeFile(join(dir, "fixture.pdf"), Buffer.from("%PDF-1.1\npool-marker\n%%EOF\n"))
		const encoded = await encodeExtract({
			uploads: { configDir: dir, seed: 3, uploads: { pool: ["./fixture.pdf"] } },
		})
		const file = (encoded.body as FormData).get("file") as File
		expect(Buffer.from(await file.arrayBuffer()).toString("ascii")).toContain("pool-marker")
	})

	it("lets resolveUpload win over pool and dummy", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-pool-"))
		await writeFile(join(dir, "fixture.pdf"), "%PDF-1.1\npool\n%%EOF\n")
		const hookBytes = new Uint8Array(Buffer.from("%PDF-1.1\nhook-wins\n%%EOF\n"))
		const encoded = await encodeExtract({
			uploads: {
				configDir: dir,
				resolveUpload: async ({ field }) =>
					field === "file" ? { bytes: hookBytes, filename: "known.pdf", mediaType: "application/pdf" } : null,
				seed: 3,
				uploads: { pool: ["./fixture.pdf"] },
			},
		})
		const file = (encoded.body as FormData).get("file") as File
		expect(Buffer.from(await file.arrayBuffer()).toString("ascii")).toContain("hook-wins")
		expect(file.name).toBe("known.pdf")
	})

	it("falls through to a dummy when resolveUpload returns null and the pool is empty", async () => {
		const encoded = await encodeExtract({
			index: 2,
			uploads: { resolveUpload: async () => null, seed: 11, uploads: { pool: [] } },
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
})

describe("encodeRequest through the client, JSON and urlencoded", () => {
	it("keeps a JSON-only create as JSON", async () => {
		const encoded = await encodeRequest(
			optionsOf({
				fields: { name: "Quarterly Report 0" },
				mediaType: "application/json",
				operationId: "table.create",
				schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
				uploads: { seed: 1 },
			}),
		)
		expect(encoded.body).toEqual({ name: "Quarterly Report 0" })
		expect(encoded.body).not.toBeInstanceOf(FormData)
		const { last } = await postEncoded("/tables", encoded)
		expect(last().contentType).toContain("application/json")
		expect(last().json).toEqual({ name: "Quarterly Report 0" })
	})

	it("sends urlencoded login, not JSON", async () => {
		const encoded = await encodeRequest(
			optionsOf({
				fields: { password: "s3cret", username: "oat" },
				mediaType: "application/x-www-form-urlencoded",
				operationId: "auth.login",
				schema: {
					properties: { password: { type: "string" }, username: { type: "string" } },
					required: ["username", "password"],
					type: "object",
				},
				uploads: { seed: 1 },
			}),
		)
		expect(encoded.body).toBeInstanceOf(URLSearchParams)
		expect(encoded.contentType).toBe("application/x-www-form-urlencoded")
		const { client, exchange, last } = await postEncoded("/login", encoded)
		expect(client.transcript.at(-1)?.requestBody).toEqual({ password: "<redacted>", username: "oat" })
		expect(exchange.requestHeaders["content-type"]).toBe("application/x-www-form-urlencoded")
		expect(last().contentType).toContain("application/x-www-form-urlencoded")
		expect(last().raw).toContain("username=oat")
		expect(last().json).toBeUndefined()
	})
})
