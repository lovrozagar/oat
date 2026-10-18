import { describe, expect, it } from "vitest"
import { dummyFile, extensionOf, mediaTypeOfExtension, mediaTypesCompatible, sniffMediaType } from "./dummy.ts"

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function file(contentMediaType?: string, filename?: string) {
	return dummyFile({
		field: "doc",
		index: 2,
		seed: 7,
		variant: "a",
		...(contentMediaType === undefined ? {} : { contentMediaType }),
		...(filename === undefined ? {} : { filename }),
	})
}

describe("extensions", () => {
	it("prefer the file name's extension, then the media type's, then bin", () => {
		expect(extensionOf("image/png", "Scan.PDF")).toBe("pdf")
		expect(extensionOf("image/png; q=1", "trailing.")).toBe("png")
		expect(extensionOf("TEXT/CSV")).toBe("csv")
		expect(extensionOf("application/x-unknown")).toBe("bin")
	})

	it("map back to a media type, with or without the dot", () => {
		expect(mediaTypeOfExtension(".JPEG")).toBe("image/jpeg")
		expect(mediaTypeOfExtension("xls")).toBe("application/vnd.ms-excel")
		expect(mediaTypeOfExtension("exe")).toBeUndefined()
	})
})

describe("dummyFile", () => {
	it("serves the known bytes of a declared type, named after the field", () => {
		const pdf = file("application/pdf; version=1")
		expect(pdf.filename).toBe("doc-a-2.pdf")
		expect(pdf.mediaType).toBe("application/pdf")
		expect(sniffMediaType(pdf.bytes)).toBe("application/pdf")
	})

	it("reads image/jpg as JPEG and finds a kind through the file name", () => {
		expect(file("image/jpg").mediaType).toBe("image/jpeg")
		const sheet = file("application/x-office", "book.xlsx")
		expect(sheet).toMatchObject({ filename: "book.xlsx", mediaType: XLSX })
	})

	it("writes text for an unknown text type and seeded bytes for anything else", () => {
		const text = file("text/plain")
		expect(text.filename).toBe("doc-a-2.txt")
		expect(new TextDecoder().decode(text.bytes)).toBe("oat dummy 7 2\n")
		const octet = file()
		expect(octet).toMatchObject({ filename: "doc-a-2.bin", mediaType: "application/octet-stream" })
		expect(octet.bytes).toHaveLength(16)
		expect(file().bytes).toEqual(octet.bytes)
		expect(file("application/x-thing").mediaType).toBe("application/x-thing")
		expect(file("; charset=x").mediaType).toBe("application/octet-stream")
		expect(file("application/x-thing", "setup.exe")).toMatchObject({
			filename: "setup.exe",
			mediaType: "application/x-thing",
		})
	})
})

describe("sniffMediaType", () => {
	it.each([
		["application/pdf", "application/pdf"],
		["image/png", "image/png"],
		["image/jpeg", "image/jpeg"],
		["image/gif", "image/gif"],
		["image/webp", "image/webp"],
		["image/tiff", "image/tiff"],
		["application/zip", "application/zip"],
	])("knows the dummy %s by its magic", (declared, sniffed) => {
		expect(sniffMediaType(file(declared).bytes)).toBe(sniffed)
	})

	it("knows big-endian TIFF and a local-header zip", () => {
		expect(sniffMediaType(Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a))).toBe("image/tiff")
		expect(sniffMediaType(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toBe("application/zip")
	})

	it("names an Office zip by its file name", () => {
		const zip = file("application/zip").bytes
		expect(sniffMediaType(zip, "a.xlsx")).toBe(XLSX)
		expect(sniffMediaType(zip, "a.docx")).toBe(DOCX)
		expect(sniffMediaType(zip, "a.zip")).toBe("application/zip")
	})

	it("falls back to the file name, then gives up", () => {
		expect(sniffMediaType(Uint8Array.of(0x25, 0x50, 0x44, 0x46))).toBeUndefined()
		expect(sniffMediaType(Uint8Array.of(1, 2), "notes.txt")).toBe("text/plain")
		expect(sniffMediaType(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0))).toBeUndefined()
	})
})

describe("mediaTypesCompatible", () => {
	it("accepts anything when nothing specific is declared", () => {
		expect(mediaTypesCompatible(undefined, "image/png")).toBe(true)
		expect(mediaTypesCompatible("", undefined)).toBe(true)
		expect(mediaTypesCompatible("application/octet-stream", "image/png")).toBe(true)
	})

	it("needs an actual type once one is declared", () => {
		expect(mediaTypesCompatible("image/png", undefined)).toBe(false)
	})

	it("matches the same type, aliases and wildcards", () => {
		expect(mediaTypesCompatible("Image/PNG; q=1", "image/png")).toBe(true)
		expect(mediaTypesCompatible("image/jpg", "image/jpeg")).toBe(true)
		expect(mediaTypesCompatible("image/jpeg", "image/jpg")).toBe(true)
		expect(mediaTypesCompatible("application/xml", "text/xml")).toBe(true)
		expect(mediaTypesCompatible("text/xml", "application/xml")).toBe(true)
		expect(mediaTypesCompatible("image/*", "image/gif")).toBe(true)
		expect(mediaTypesCompatible("image/*", "text/plain")).toBe(false)
		expect(mediaTypesCompatible("image/png", "image/gif")).toBe(false)
	})
})
