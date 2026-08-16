/**
 * Tiny valid files so backends that sniff magic do not 400 on "not a PDF".
 *
 * oat does not OCR or interpret these; they only have to look like the declared type.
 */

import { mulberry32 } from "./fixture.ts"

export interface DummyFile {
	bytes: Uint8Array
	filename: string
	mediaType: string
}

const PDF = textBytes(`%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj
trailer<</Root 1 0 R>>
%%EOF
`)

/* 1×1 RGB PNG. */
const PNG = hex(
	"89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
)

/* 1×1 JPEG (JFIF). */
const JPEG = hex(
	"ffd8ffe000104a46494600010100000100010000ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101ffc0000b080001000101011100ffc40014100100000000000000000000000000000000ffda00080001000100003f00fb00ffd9",
)

/* 1×1 GIF89a. */
const GIF = hex("47494638396101000100800000ffffff0000002c00000000010001000002024401003b")

/* 1×1 lossless WebP. */
const WEBP = hex("52494646240000005745425056503820180000003001009d012a01000002000000340025a8000002")

/* 1×1 little-endian TIFF, white pixel. */
const TIFF = hex(
	"49492a00080000000e0000fe0004000100000000000000000100030001000000010000000101030001000000010000000201030003000000120000000301030001000000010000000601030001000000020000001101040001000000080000001501030001000000010000001601040001000000010000001701040001000000030000001a01050001000000c40000001b01050001000000cc0000001c010300010000000100000028010300010000000200000000000000080008000800000000000100000000000100",
)

const EMPTY_ZIP = hex("504b0506000000000000000000000000000000000000")

const TEXT_HTML = textBytes("<!doctype html><title>oat</title>")
const TEXT_CSV = textBytes("a,b\n1,2\n")
const TEXT_JSON = textBytes("{}")
const TEXT_XML = textBytes("<oat/>")

interface DummyKind {
	mediaType: string
	ext: string
	bytes: Uint8Array | ((seed: number, index: number) => Uint8Array)
}

const KINDS: DummyKind[] = [
	{ bytes: PDF, ext: "pdf", mediaType: "application/pdf" },
	{ bytes: PNG, ext: "png", mediaType: "image/png" },
	{ bytes: JPEG, ext: "jpg", mediaType: "image/jpeg" },
	{ bytes: GIF, ext: "gif", mediaType: "image/gif" },
	{ bytes: WEBP, ext: "webp", mediaType: "image/webp" },
	{ bytes: TIFF, ext: "tif", mediaType: "image/tiff" },
	{ bytes: TEXT_HTML, ext: "html", mediaType: "text/html" },
	{ bytes: TEXT_CSV, ext: "csv", mediaType: "text/csv" },
	{ bytes: TEXT_JSON, ext: "json", mediaType: "application/json" },
	{ bytes: TEXT_XML, ext: "xml", mediaType: "application/xml" },
	{ bytes: TEXT_XML, ext: "xml", mediaType: "text/xml" },
	{ bytes: EMPTY_ZIP, ext: "zip", mediaType: "application/zip" },
	{
		bytes: EMPTY_ZIP,
		ext: "xlsx",
		mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	},
	{
		bytes: EMPTY_ZIP,
		ext: "docx",
		mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	},
]

const EXT_OF: Record<string, string> = {
	"application/json": "json",
	"application/octet-stream": "bin",
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/xml": "xml",
	"application/zip": "zip",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/tiff": "tif",
	"image/webp": "webp",
	"text/csv": "csv",
	"text/html": "html",
	"text/plain": "txt",
	"text/xml": "xml",
}

const MEDIA_OF_EXT: Record<string, string> = {
	bin: "application/octet-stream",
	csv: "text/csv",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	gif: "image/gif",
	htm: "text/html",
	html: "text/html",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	pdf: "application/pdf",
	png: "image/png",
	tif: "image/tiff",
	tiff: "image/tiff",
	txt: "text/plain",
	webp: "image/webp",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xml: "application/xml",
	zip: "application/zip",
}

export function extensionOf(mediaType: string, filename?: string): string {
	if (filename !== undefined) {
		const dot = filename.lastIndexOf(".")
		if (dot >= 0 && dot < filename.length - 1) return filename.slice(dot + 1).toLowerCase()
	}
	const bare = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
	return EXT_OF[bare] ?? "bin"
}

export function mediaTypeOfExtension(ext: string): string | undefined {
	return MEDIA_OF_EXT[ext.toLowerCase().replace(/^\./, "")]
}

export function dummyFile(options: {
	field: string
	variant: string
	index: number
	seed: number
	contentMediaType?: string
	filename?: string
}): DummyFile {
	const mediaType = (options.contentMediaType ?? "application/octet-stream").split(";")[0]?.trim() ?? ""
	const kind = kindOf(mediaType, options.filename)
	const ext = kind?.ext ?? extensionOf(mediaType, options.filename)
	const filename = options.filename ?? `${options.field}-${options.variant}-${options.index}.${ext}`
	const bytes = bytesOf(kind, mediaType, options.seed, options.index)
	return { bytes, filename, mediaType: kind?.mediaType ?? (mediaType === "" ? "application/octet-stream" : mediaType) }
}

function kindOf(mediaType: string, filename?: string): DummyKind | undefined {
	const bare = mediaType.toLowerCase()
	const byMedia = KINDS.find((kind) => kind.mediaType === bare)
	if (byMedia !== undefined) return byMedia
	if (bare === "image/jpg") return KINDS.find((kind) => kind.mediaType === "image/jpeg")
	const ext = extensionOf(mediaType, filename)
	const mapped = mediaTypeOfExtension(ext)
	if (mapped !== undefined) return KINDS.find((kind) => kind.mediaType === mapped)
	return undefined
}

function bytesOf(kind: DummyKind | undefined, mediaType: string, seed: number, index: number): Uint8Array {
	if (kind !== undefined) {
		return typeof kind.bytes === "function" ? kind.bytes(seed, index) : kind.bytes
	}
	if (mediaType === "text/plain" || mediaType.startsWith("text/")) {
		return textBytes(`oat dummy ${seed} ${index}\n`)
	}
	return octetDummy(seed, index)
}

function octetDummy(seed: number, index: number): Uint8Array {
	const rand = mulberry32((seed ^ (index * 7919)) >>> 0)
	const out = new Uint8Array(16)
	for (let i = 0; i < out.length; i++) out[i] = Math.floor(rand() * 256)
	return out
}

export function sniffMediaType(bytes: Uint8Array, filename?: string): string | undefined {
	if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
		return "application/pdf"
	}
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png"
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return "image/gif"
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp"
	}
	if (
		bytes.length >= 4 &&
		((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
			(bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
	) {
		return "image/tiff"
	}
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
		const ext = filename === undefined ? "" : extensionOf("", filename)
		if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		return "application/zip"
	}
	if (filename !== undefined) return mediaTypeOfExtension(extensionOf("", filename))
	return undefined
}

export function mediaTypesCompatible(declared: string | undefined, actual: string | undefined): boolean {
	if (declared === undefined || declared === "" || declared === "application/octet-stream") return true
	if (actual === undefined) return false
	const want = declared.split(";")[0]?.trim().toLowerCase() ?? ""
	const have = actual.split(";")[0]?.trim().toLowerCase() ?? ""
	if (want === have) return true
	if (want === "image/jpg" && have === "image/jpeg") return true
	if (want === "image/jpeg" && have === "image/jpg") return true
	if (want.endsWith("/*")) return have.startsWith(want.slice(0, -1))
	if (want === "application/xml" && have === "text/xml") return true
	if (want === "text/xml" && have === "application/xml") return true
	return false
}

function hex(text: string): Uint8Array {
	const clean = text.replace(/\s+/g, "")
	const out = new Uint8Array(clean.length / 2)
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	return out
}

function textBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}
