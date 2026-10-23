import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Hooks, Uploads } from "../../src/config/types/hooks.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Listeners, reply, serve } from "../support/effects-fixtures.ts"

/*
 * A multipart upload through a run: the file part carries a pool file, one request per `each` file,
 * what `resolveUpload` returns, or a dummy of the declared type when nothing is configured. The
 * reference has no upload route, so a small document over a server that parses each form stands in.
 */

const listeners = new Listeners()
afterEach(() => listeners.closeAll())

const DOCUMENT = { properties: { id: { type: "string" }, title: { type: "string" } }, type: "object" }

const SPEC = {
	info: { title: "uploads", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/documents": {
			post: {
				operationId: "document.upload",
				requestBody: {
					content: {
						"multipart/form-data": {
							schema: {
								properties: {
									file: { contentMediaType: "application/pdf", format: "binary", type: "string" },
									title: { type: "string" },
								},
								required: ["file", "title"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: {
					"201": { content: { "application/json": { schema: DOCUMENT } }, description: "stored" },
					"400": { description: "no file" },
				},
				"x-entity": { action: "create", identity: "id", name: "document" },
			},
			get: {
				operationId: "document.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { documents: { items: DOCUMENT, type: "array" } }, type: "object" },
							},
						},
						description: "every document",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "document" },
			},
		},
	},
} as unknown as OpenApiDocument

/** One upload as the server parsed it: the file part's name, type and text, and the title. */
interface Received {
	filename: string
	type: string
	text: string
	title: string
}

async function uploadApi(): Promise<{ received: Received[]; url: string }> {
	const received: Received[] = []
	const server = await serve(listeners, SPEC, [
		({ method, res, url }) => {
			if (url.pathname !== "/v1/documents" || method !== "GET") return false
			const documents = received.map((upload, i) => ({ id: `doc_${i + 1}`, title: upload.title }))
			return reply(res, 200, { documents })
		},
		async ({ method, req, res, url }) => {
			if (url.pathname !== "/v1/documents" || method !== "POST") return false
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const headers = { "content-type": req.headers["content-type"] ?? "" }
			const form = await new Response(Buffer.concat(chunks), { headers }).formData().catch(() => null)
			const file = form?.get("file")
			const title = form?.get("title")
			if (!(file instanceof File) || typeof title !== "string") return reply(res, 400, { error: "file and title" })
			received.push({ filename: file.name, text: await file.text(), title, type: file.type })
			return reply(res, 201, { id: `doc_${received.length}`, title })
		},
	])
	return { received, url: server.url }
}

/* A temp directory holding a small PDF per name, each marked with its own name. */
async function pdfs(...names: string[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oat-uploads-"))
	for (const name of names) await writeFile(join(dir, name), `%PDF-1.4\n${name}\n%%EOF\n`)
	return dir
}

async function uploadRun(options: { dir?: string; uploads?: Uploads; hooks?: Hooks }) {
	const { received, url } = await uploadApi()
	const result = await run({
		baseUrl: url,
		principals: { alpha: {} },
		seed: 1,
		spec: `${url}/v1/openapi/spec`,
		...(options.dir === undefined ? {} : { configDir: options.dir }),
		...(options.uploads === undefined ? {} : { uploads: options.uploads }),
		...(options.hooks === undefined ? {} : { hooks: options.hooks }),
	})
	const status = result.scope.operations.find((op) => op.operationId === "document.upload")?.status
	return { received, result, status }
}

describe("an upload", () => {
	it("sends a pool file as the file part", async () => {
		const dir = await pdfs("report.pdf")
		const { received, status } = await uploadRun({ dir, uploads: { pool: ["./*.pdf"] } })
		expect(status).toBe("passed")
		expect(received[0]).toMatchObject({ filename: "report.pdf", text: "%PDF-1.4\nreport.pdf\n%%EOF\n" })
		expect(received.every((upload) => upload.filename === "report.pdf")).toBe(true)
	})

	it("sends the operation once per `each` file, in name order", async () => {
		const dir = await pdfs("b.pdf", "a.pdf")
		const { received, status } = await uploadRun({ dir, uploads: { each: { "document.upload": ["./*.pdf"] } } })
		expect(status).toBe("passed")
		expect(received.map((upload) => upload.filename)).toEqual(["a.pdf", "b.pdf"])
		expect(received.map((upload) => upload.text)).toEqual(["%PDF-1.4\na.pdf\n%%EOF\n", "%PDF-1.4\nb.pdf\n%%EOF\n"])
	})

	it("sends the file and fields resolveUpload returns", async () => {
		const bytes = new TextEncoder().encode("%PDF-1.4\nfrom the hook\n%%EOF\n")
		const hooks: Hooks = {
			resolveUpload: () =>
				Promise.resolve({
					fields: { file: { bytes, filename: "hooked.pdf", mediaType: "application/pdf" }, title: "Q3" },
				}),
		}
		const { received, status } = await uploadRun({ hooks })
		expect(status).toBe("passed")
		expect(received[0]).toEqual({
			filename: "hooked.pdf",
			text: "%PDF-1.4\nfrom the hook\n%%EOF\n",
			title: "Q3",
			type: "application/pdf",
		})
	})

	it("sends a dummy of the declared media type when nothing is configured", async () => {
		const { received, status } = await uploadRun({})
		expect(status).toBe("passed")
		expect(received[0]?.type).toBe("application/pdf")
		expect(received[0]?.text.startsWith("%PDF-")).toBe(true)
	})
})

describe("the required-field probe on an upload", () => {
	it("omits the required file part it names, so a server that refuses it is not reported", async () => {
		const { result } = await uploadRun({})
		const probe = result.client.transcript.find((exchange) => exchange.check === "validation.required-enforced")
		const parts = (probe?.requestBody as { parts?: Array<{ field: string }> } | undefined)?.parts ?? []
		expect(parts.map((part) => part.field)).toEqual(["title"])
		expect(probe?.status).toBe(400)
		expect(result.findings.filter((finding) => finding.check === "validation.required-enforced")).toEqual([])
	})
})
