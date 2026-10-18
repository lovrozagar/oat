import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { UploadRequest } from "../config/types/hooks.ts"
import {
	expandPattern,
	isFieldOverride,
	isUploadFile,
	resetUploadPool,
	resolveUploadFile,
	resolveUploadOverride,
	type UploadContext,
} from "./upload.ts"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

const request = (more: Partial<UploadRequest> = {}): UploadRequest => ({
	field: "doc",
	index: 0,
	mediaType: "multipart/form-data",
	operationId: "docs.create",
	variant: "baseline",
	...more,
})

/* A folder of files: `name → bytes`, nested by `/`. */
function folder(files: Record<string, Uint8Array | string>): string {
	const root = mkdtempSync(join(tmpdir(), "oat-upload-"))
	for (const [name, bytes] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true })
		writeFileSync(join(root, name), bytes)
	}
	return root
}

afterEach(() => {
	resetUploadPool()
})

describe("the hook's answer", () => {
	it("is asked only when there is a hook", async () => {
		expect(await resolveUploadOverride(request(), { seed: 1 })).toBeNull()
		const file = { bytes: PDF, filename: "a.pdf", mediaType: "application/pdf" }
		expect(await resolveUploadOverride(request(), { resolveUpload: async () => file, seed: 1 })).toBe(file)
	})

	it("is a file, or fields to send instead, by its shape", () => {
		expect(isUploadFile({ bytes: PDF, filename: "a.pdf", mediaType: "application/pdf" })).toBe(true)
		expect(isUploadFile({ bytes: "x", filename: "a", mediaType: "b" })).toBe(false)
		expect(isUploadFile(null)).toBe(false)
		expect(isUploadFile("file")).toBe(false)
		expect(isFieldOverride({ fields: { a: "1" } })).toBe(true)
		expect(isFieldOverride({ fields: null })).toBe(false)
		expect(isFieldOverride({ fields: "a" })).toBe(false)
		expect(isFieldOverride({})).toBe(false)
		expect(isFieldOverride(null)).toBe(false)
	})
})

describe("resolveUploadFile from an uploads.each slot", () => {
	it("sends the slot's file, typed by its bytes or its name", async () => {
		const root = folder({ "a.png": PNG, "notes.txt": "hello" })
		const slot = (filename: string) => ({ filename, index: 0, path: join(root, filename), total: 1 })
		const png = await resolveUploadFile(request({ fixture: slot("a.png") }), { seed: 1 })
		expect([png.filename, png.mediaType]).toEqual(["a.png", "image/png"])
		const text = await resolveUploadFile(request(), { fixture: slot("notes.txt"), seed: 1 })
		expect(text.mediaType).toBe("text/plain")
	})

	it("warns once and falls back when the slot cannot be read", async () => {
		const warned: string[] = []
		const context: UploadContext = { seed: 1, warn: (message) => warned.push(message) }
		const fixture = { filename: "gone.bin", index: 0, path: "/nonexistent/gone.bin", total: 1 }
		const file = await resolveUploadFile(request({ fixture }), context)
		await resolveUploadFile(request({ fixture }), context)
		expect(file.filename).toBe("doc-baseline-0.bin")
		expect(warned).toEqual(["uploads.each could not read /nonexistent/gone.bin"])
	})
})

describe("resolveUploadFile from the pool", () => {
	it("picks a file of the declared type, the same one for the same seed", async () => {
		const root = folder({ "a.pdf": PDF, "b.png": PNG, "c.png": PNG })
		const context: UploadContext = { configDir: root, seed: 3, uploads: { pool: ["."] } }
		const picked = await resolveUploadFile(request({ contentMediaType: "image/png" }), context)
		expect(picked.mediaType).toBe("image/png")
		expect((await resolveUploadFile(request({ contentMediaType: "image/png" }), context)).filename).toBe(
			picked.filename,
		)
		const pdf = await resolveUploadFile(request({ contentMediaType: "application/pdf" }), context)
		expect(pdf.filename).toBe("a.pdf")
	})

	it("matches by the requested file name's extension, and takes any file for an untyped part", async () => {
		const root = folder({ "a.pdf": PDF, "b.png": PNG })
		const context: UploadContext = { configDir: root, seed: 1, uploads: { pool: ["*.p*"] } }
		const byName = await resolveUploadFile(request({ contentMediaType: "text/csv", filename: "scan.PNG" }), context)
		expect(byName.filename).toBe("b.png")
		const any = await resolveUploadFile(request(), context)
		expect(["a.pdf", "b.png"]).toContain(any.filename)
	})

	it("falls back to a dummy when nothing in the pool fits, or there is no pool", async () => {
		const root = folder({ "a.pdf": PDF })
		const csv = await resolveUploadFile(request({ contentMediaType: "text/csv" }), {
			configDir: root,
			seed: 1,
			uploads: { pool: ["."] },
		})
		expect([csv.filename, csv.mediaType]).toEqual(["doc-baseline-0.csv", "text/csv"])
		const empty = await resolveUploadFile(request(), { seed: 1, uploads: { pool: [] } })
		expect(empty.filename).toBe("doc-baseline-0.bin")
	})
})

describe("expandPattern", () => {
	it("reads a file, a directory, and a glob, recursive with **", async () => {
		const root = folder({ "a.pdf": PDF, "deep/b.pdf": PDF, "deep/c.png": PNG, "x+y.pdf": PDF })
		expect(await expandPattern("a.pdf", root)).toEqual([join(root, "a.pdf")])
		expect((await expandPattern("deep", root)).toSorted()).toEqual([join(root, "deep/b.pdf"), join(root, "deep/c.png")])
		expect((await expandPattern("**/*.pdf", root)).toSorted()).toEqual(
			[join(root, "a.pdf"), join(root, "deep/b.pdf"), join(root, "x+y.pdf")].toSorted(),
		)
		expect(await expandPattern("deep/?.png", root)).toEqual([join(root, "deep/c.png")])
		expect(await expandPattern("deep/**", root)).toHaveLength(2)
	})

	it("warns once, under its label, for a path or a glob base that is not there", async () => {
		const root = folder({ "a.pdf": PDF })
		const warned: string[] = []
		const warn = (message: string) => warned.push(message)
		expect(await expandPattern("missing.pdf", root, warn)).toEqual([])
		expect(await expandPattern("nowhere/*.pdf", root, warn, "uploads.each")).toEqual([])
		expect(await expandPattern("a.pdf/*.x", root, warn)).toEqual([])
		expect(await expandPattern("missing.pdf", root, warn)).toEqual([])
		expect(warned).toEqual([
			"uploads.pool path not found: missing.pdf",
			"uploads.each path not found: nowhere/*.pdf",
			"uploads.pool path not found: a.pdf/*.x",
		])
	})
})
