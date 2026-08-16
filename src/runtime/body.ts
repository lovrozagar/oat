/**
 * Turns a generated field map into the body the document asked for.
 *
 * JSON stays a plain object. urlencoded becomes URLSearchParams. Multipart becomes
 * FormData — file parts are resolved (hook → pool → dummy), never JSON.stringified.
 */

import type { UploadFile, UploadRequest } from "../config/define-config.ts"
import { requestContent } from "../spec/collection.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import {
	type UploadContext,
	isFieldOverride,
	isUploadFile,
	resolveUploadFile,
	resolveUploadOverride,
} from "./upload.ts"

export interface EncodedBody {
	body: unknown
	/** `null` means headers are already final (FormData — fetch sets the boundary). */
	contentType: string | null | undefined
}

export interface EncodeOptions {
	operationId: string
	mediaType: string
	schema: Record<string, unknown>
	encoding?: Record<string, { contentType?: string }>
	fields: Record<string, unknown>
	variant: string
	index: number
	uploads: UploadContext
}

export function requestContentOf(op: OperationModel, model: SpecModel): ReturnType<typeof requestContent> {
	const raw = model.rawOperations.get(op.operationId)
	return raw === undefined ? null : requestContent(raw)
}

export async function encodeForOperation(
	op: OperationModel,
	model: SpecModel,
	fields: Record<string, unknown>,
	uploads: UploadContext,
	variant = "baseline",
	index = 0,
): Promise<EncodedBody> {
	const content = requestContentOf(op, model)
	if (content === null) return { body: fields, contentType: undefined }
	const options: EncodeOptions = {
		fields,
		index,
		mediaType: content.mediaType,
		operationId: op.operationId,
		schema: content.schema,
		uploads,
		variant,
	}
	if (content.encoding !== undefined) options.encoding = content.encoding
	return encodeRequest(options)
}

export async function encodeRequest(options: EncodeOptions): Promise<EncodedBody> {
	const media = options.mediaType.toLowerCase()
	if (media.startsWith("multipart/")) {
		return { body: await encodeMultipart(options), contentType: null }
	}
	if (media.includes("x-www-form-urlencoded")) {
		return { body: encodeUrlencoded(options.fields), contentType: "application/x-www-form-urlencoded" }
	}
	return { body: options.fields, contentType: undefined }
}

async function encodeMultipart(options: EncodeOptions): Promise<FormData> {
	const form = new FormData()
	const properties = propertiesOf(options.schema)
	const required = requiredOf(options.schema)
	const names = filePartNames(properties, required, options)
	const hookHits = new Map<string, Awaited<ReturnType<typeof resolveUploadOverride>>>()
	for (const name of names) {
		const schema = properties[name] ?? additionalSchema(options.schema) ?? {}
		const resolved = await resolveUploadOverride(uploadRequest(name, schema, options), options.uploads)
		hookHits.set(name, resolved)
		if (isFieldOverride(resolved)) {
			appendFields(form, resolved.fields)
			return form
		}
	}

	const sent = new Set<string>()
	for (const [name, schema] of Object.entries(properties)) {
		sent.add(name)
		if (isFilePart(schema, options.encoding?.[name])) {
			const hit = hookHits.get(name)
			const file = isUploadFile(hit)
				? hit
				: await fileForPart(name, schema, { ...options, uploads: { ...options.uploads, resolveUpload: undefined } })
			appendFile(form, name, file)
			continue
		}
		const value = options.fields[name]
		if (value === undefined || value === null) continue
		appendScalar(form, name, value)
	}

	await appendAdditionalFile(form, options, sent, required)
	return form
}

function encodeUrlencoded(fields: Record<string, unknown>): URLSearchParams {
	const params = new URLSearchParams()
	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined || value === null) continue
		if (typeof value === "object") continue
		params.set(name, String(value))
	}
	return params
}

function filePartNames(
	properties: Record<string, Record<string, unknown>>,
	required: string[],
	options: EncodeOptions,
): string[] {
	const fromProps = Object.entries(properties)
		.filter(([name, schema]) => isFilePart(schema, options.encoding?.[name]))
		.map(([name]) => name)
	if (fromProps.length > 0) return fromProps
	if (isFilePart(additionalSchema(options.schema) ?? {}, undefined)) {
		const extra = required.find((name) => properties[name] === undefined)
		if (extra !== undefined) return [extra]
	}
	return []
}

async function appendAdditionalFile(
	form: FormData,
	options: EncodeOptions,
	sent: Set<string>,
	required: string[],
): Promise<void> {
	const additional = additionalSchema(options.schema)
	if (!isFilePart(additional ?? {}, undefined)) return
	const already = [...form.keys()].some((name) => {
		const value = form.get(name)
		return typeof File !== "undefined" && value instanceof File
	})
	if (already) return
	const name =
		required.find((item) => !sent.has(item)) ??
		required.find((item) => isFilePart(propertiesOf(options.schema)[item] ?? {}, options.encoding?.[item]))
	if (name === undefined) return
	appendFile(form, name, await fileForPart(name, additional ?? {}, options))
}

async function fileForPart(name: string, schema: Record<string, unknown>, options: EncodeOptions): Promise<UploadFile> {
	const request = uploadRequest(name, schema, options)
	const file = await resolveUploadFile(request, options.uploads)
	return file
}

function uploadRequest(name: string, schema: Record<string, unknown>, options: EncodeOptions): UploadRequest {
	const contentMediaType = contentMediaTypeOf(schema, options.encoding?.[name])
	const request: UploadRequest = {
		field: name,
		index: options.index,
		mediaType: options.mediaType,
		operationId: options.operationId,
		variant: options.variant,
	}
	if (contentMediaType !== undefined) request.contentMediaType = contentMediaType
	const filename = typeof schema.filename === "string" ? schema.filename : undefined
	if (filename !== undefined) request.filename = filename
	return request
}

function appendFields(form: FormData, fields: Record<string, string | UploadFile>): void {
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string") form.append(name, value)
		else appendFile(form, name, value)
	}
}

function appendFile(form: FormData, name: string, file: UploadFile): void {
	const blob = new File([file.bytes], file.filename, { type: file.mediaType })
	form.append(name, blob, file.filename)
}

function appendScalar(form: FormData, name: string, value: unknown): void {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		form.append(name, String(value))
		return
	}
	form.append(name, JSON.stringify(value))
}

export function isFilePart(schema: unknown, encoding?: { contentType?: string }): boolean {
	if (schema === null || typeof schema !== "object") return false
	const record = schema as Record<string, unknown>
	if (isBinarySchema(record)) return true
	const encoded = encoding?.contentType
	if (typeof encoded === "string" && encoded !== "" && !isJsonMedia(encoded)) return true
	const union = record.oneOf ?? record.anyOf
	if (Array.isArray(union)) return union.some((branch) => isFilePart(branch, encoding))
	return false
}

function isBinarySchema(schema: Record<string, unknown>): boolean {
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	if (format === "binary" || format === "byte") return true
	const encoding = typeof schema.contentEncoding === "string" ? schema.contentEncoding.toLowerCase() : ""
	if (encoding === "binary" || encoding === "base64") return true
	const media = typeof schema.contentMediaType === "string" ? schema.contentMediaType : ""
	if (media !== "" && !isJsonMedia(media)) return true
	return false
}

function isJsonMedia(mediaType: string): boolean {
	const bare = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
	return bare.includes("json")
}

function contentMediaTypeOf(schema: Record<string, unknown>, encoding?: { contentType?: string }): string | undefined {
	if (typeof encoding?.contentType === "string" && encoding.contentType !== "") {
		return encoding.contentType.split(",")[0]?.trim()
	}
	if (typeof schema.contentMediaType === "string" && schema.contentMediaType !== "") {
		return schema.contentMediaType
	}
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	if (format === "binary" || format === "byte") return "application/octet-stream"
	return undefined
}

function propertiesOf(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return {}
	const out: Record<string, Record<string, unknown>> = {}
	for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
		if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) out[name] = raw as Record<string, unknown>
	}
	return out
}

function requiredOf(schema: Record<string, unknown>): string[] {
	return Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string")
		: []
}

function additionalSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
	const additional = schema.additionalProperties
	if (additional === null || typeof additional !== "object" || Array.isArray(additional)) return undefined
	return additional as Record<string, unknown>
}
