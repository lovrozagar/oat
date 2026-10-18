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

const PDF = /* @__PURE__ */ textBytes(`%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj
trailer<</Root 1 0 R>>
%%EOF
`)

/* 1×1 RGB PNG. */
const PNG = /* @__PURE__ */ hex(
	"89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
)

/* 1×1 JPEG (JFIF). */
const JPEG = /* @__PURE__ */ hex(
	"ffd8ffe000104a46494600010100000100010000ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101ffc0000b080001000101011100ffc40014100100000000000000000000000000000000ffda00080001000100003f00fb00ffd9",
)

/* 1×1 GIF89a. */
const GIF = /* @__PURE__ */ hex("47494638396101000100800000ffffff0000002c00000000010001000002024401003b")

/* 1×1 lossless WebP. */
const WEBP = /* @__PURE__ */ hex("52494646240000005745425056503820180000003001009d012a01000002000000340025a8000002")

/* 1×1 little-endian TIFF, white pixel. */
const TIFF = /* @__PURE__ */ hex(
	"49492a00080000000e0000fe0004000100000000000000000100030001000000010000000101030001000000010000000201030003000000120000000301030001000000010000000601030001000000020000001101040001000000080000001501030001000000010000001601040001000000010000001701040001000000030000001a01050001000000c40000001b01050001000000cc0000001c010300010000000100000028010300010000000200000000000000080008000800000000000100000000000100",
)

const EMPTY_ZIP = /* @__PURE__ */ hex("504b0506000000000000000000000000000000000000")

const TEXT_HTML = /* @__PURE__ */ textBytes("<!doctype html><title>oat</title>")
const TEXT_CSV = /* @__PURE__ */ textBytes("a,b\n1,2\n")
const TEXT_JSON = /* @__PURE__ */ textBytes("{}")
const TEXT_XML = /* @__PURE__ */ textBytes("<oat/>")

interface DummyKind {
	mediaType: string
	ext: string
	bytes: Uint8Array
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
	return EXT_OF[bareType(mediaType)] ?? "bin"
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
	const mediaType = withoutParameters(options.contentMediaType ?? "application/octet-stream")
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
	if (kind !== undefined) return kind.bytes
	if (mediaType.startsWith("text/")) return textBytes(`oat dummy ${seed} ${index}\n`)
	return octetDummy(seed, index)
}

function octetDummy(seed: number, index: number): Uint8Array {
	const rand = mulberry32((seed ^ (index * 7919)) >>> 0)
	const out = new Uint8Array(16)
	for (let i = 0; i < out.length; i++) out[i] = Math.floor(rand() * 256)
	return out
}

/** Magic bytes a file starts with: each part is the bytes expected at an offset. */
interface Signature {
	mediaType: string
	minLength: number
	parts: readonly (readonly [offset: number, bytes: readonly number[]])[]
}

/* First match wins, so the order is the order the formats are tried in. */
const SIGNATURES: readonly Signature[] = [
	{ mediaType: "application/pdf", minLength: 5, parts: [[0, [0x25, 0x50, 0x44, 0x46]]] },
	{ mediaType: "image/png", minLength: 8, parts: [[0, [0x89, 0x50, 0x4e, 0x47]]] },
	{ mediaType: "image/jpeg", minLength: 3, parts: [[0, [0xff, 0xd8, 0xff]]] },
	{ mediaType: "image/gif", minLength: 6, parts: [[0, [0x47, 0x49, 0x46, 0x38]]] },
	{
		mediaType: "image/webp",
		minLength: 12,
		parts: [
			[0, [0x52, 0x49, 0x46, 0x46]],
			[8, [0x57, 0x45, 0x42, 0x50]],
		],
	},
	{ mediaType: "image/tiff", minLength: 4, parts: [[0, [0x49, 0x49, 0x2a, 0x00]]] },
	{ mediaType: "image/tiff", minLength: 4, parts: [[0, [0x4d, 0x4d, 0x00, 0x2a]]] },
	{ mediaType: "application/zip", minLength: 4, parts: [[0, [0x50, 0x4b, 0x03]]] },
	{ mediaType: "application/zip", minLength: 4, parts: [[0, [0x50, 0x4b, 0x05]]] },
]

function matches(bytes: Uint8Array, signature: Signature): boolean {
	if (bytes.length < signature.minLength) return false
	return signature.parts.every(([offset, expected]) => expected.every((byte, i) => bytes[offset + i] === byte))
}

/** A zip is also an Office document: the file name tells which. */
function zipMediaType(filename?: string): string {
	const ext = filename === undefined ? "" : extensionOf("", filename)
	if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	return "application/zip"
}

export function sniffMediaType(bytes: Uint8Array, filename?: string): string | undefined {
	const sniffed = SIGNATURES.find((signature) => matches(bytes, signature))?.mediaType
	if (sniffed === "application/zip") return zipMediaType(filename)
	if (sniffed !== undefined) return sniffed
	if (filename !== undefined) return mediaTypeOfExtension(extensionOf("", filename))
	return undefined
}

/* Declared and actual types that name the same format, as "declared actual". */
const EQUIVALENT: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"application/xml text/xml",
	"image/jpeg image/jpg",
	"image/jpg image/jpeg",
	"text/xml application/xml",
])

export function mediaTypesCompatible(declared: string | undefined, actual: string | undefined): boolean {
	if (declared === undefined || declared === "" || declared === "application/octet-stream") return true
	if (actual === undefined) return false
	const want = bareType(declared)
	const have = bareType(actual)
	if (want.endsWith("/*")) return have.startsWith(want.slice(0, -1))
	return want === have || EQUIVALENT.has(`${want} ${have}`)
}

/** A media type without its parameters: "text/plain; charset=utf-8" is "text/plain". */
function withoutParameters(mediaType: string): string {
	return mediaType.replace(/;[\s\S]*/, "").trim()
}

function bareType(mediaType: string): string {
	return withoutParameters(mediaType).toLowerCase()
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
