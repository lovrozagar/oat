/**
 * Turns a generated field map into the body the document asked for.
 *
 * JSON stays a plain object. urlencoded becomes URLSearchParams. Multipart becomes
 * FormData — file parts are resolved (hook → pool → dummy), never JSON.stringified.
 */

import type { UploadFile, UploadRequest } from "../config/define-config.ts"
import { requestContent } from "../spec/collection.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { applyResolveInput } from "./input.ts"
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

/** An OpenAPI Encoding Object, as far as serialization goes. */
export interface FieldEncoding {
	contentType?: string
	style?: string
	explode?: boolean
}

/**
 * One form field as the key/value pairs the operation's `encoding` says it becomes.
 *
 * The OpenAPI default for a form is `style: form, explode: true`: an array repeats its key per
 * item, an object spreads its properties as keys of their own. `deepObject` writes `name[key]`;
 * `explode: false` joins with the style's delimiter; a JSON `contentType` sends the value as JSON.
 */
export function formPairs(name: string, value: unknown, encoding: FieldEncoding | undefined): Array<[string, string]> {
	const scalar = (item: unknown): string =>
		item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)
	if (value === undefined || value === null) return []
	if (encoding?.contentType?.includes("json") === true) return [[name, JSON.stringify(value)]]
	const explode = encoding?.explode ?? true
	const style = encoding?.style ?? "form"
	if (Array.isArray(value)) {
		if (explode) return value.map((item) => [name, scalar(item)])
		const delimiter = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ","
		return [[name, value.map(scalar).join(delimiter)]]
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
		if (style === "deepObject") return entries.map(([key, item]) => [`${name}[${key}]`, scalar(item)])
		if (explode) return entries.map(([key, item]) => [key, scalar(item)])
		return [[name, entries.flatMap(([key, item]) => [key, scalar(item)]).join(",")]]
	}
	return [[name, String(value)]]
}

export interface EncodeOptions {
	operationId: string
	mediaType: string
	schema: Record<string, unknown>
	encoding?: Record<string, FieldEncoding>
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
	const fields = await applyResolveInput(
		options.fields,
		options.operationId,
		options.schema,
		options.uploads.resolveInput,
	)
	const next = { ...options, fields }
	const media = options.mediaType.toLowerCase()
	if (media.startsWith("multipart/")) {
		return { body: await encodeMultipart(next), contentType: null }
	}
	if (media.includes("x-www-form-urlencoded")) {
		return {
			body: encodeUrlencoded(next.fields, next.encoding),
			contentType: "application/x-www-form-urlencoded",
		}
	}
	return { body: next.fields, contentType: undefined }
}

async function encodeMultipart(options: EncodeOptions): Promise<FormData> {
	const form = new FormData()
	const properties = propertiesOf(options.schema)
	const required = requiredOf(options.schema)
	const names = filePartNames(properties, required, options)
	const hookHits = new Map<string, Awaited<ReturnType<typeof resolveUploadOverride>>>()
	const overlays: Array<Record<string, string | UploadFile>> = []
	for (const name of names) {
		const schema = properties[name] ?? additionalSchema(options.schema) ?? {}
		const resolved = await resolveUploadOverride(uploadRequest(name, schema, options), options.uploads)
		hookHits.set(name, resolved)
		if (isFieldOverride(resolved)) {
			if (overrideIncludesFile(resolved.fields, names)) {
				appendFields(form, resolved.fields)
				return form
			}
			overlays.push(resolved.fields)
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
		appendValue(form, name, value, options.encoding?.[name])
	}

	await appendAdditionalFile(form, options, sent, required)
	for (const overlay of overlays) appendFields(form, overlay)
	return form
}

function overrideIncludesFile(fields: Record<string, string | UploadFile>, fileNames: string[]): boolean {
	for (const [name, value] of Object.entries(fields)) {
		if (isUploadFile(value) && (fileNames.includes(name) || fileNames.length === 0)) return true
	}
	return false
}

function encodeUrlencoded(fields: Record<string, unknown>, encoding?: Record<string, FieldEncoding>): URLSearchParams {
	const params = new URLSearchParams()
	for (const [name, value] of Object.entries(fields)) {
		for (const [key, item] of formPairs(name, value, encoding?.[name])) params.append(key, item)
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
	const fixture = options.uploads.fixture
	if (fixture !== undefined) request.fixture = fixture
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

/**
 * One multipart field: a part per array item, and an object as one JSON part (the OpenAPI
 * default content type for an object in multipart) unless the encoding says otherwise.
 */
function appendValue(form: FormData, name: string, value: unknown, encoding: FieldEncoding | undefined): void {
	const json = (item: unknown): Blob => new Blob([JSON.stringify(item)], { type: "application/json" })
	if (encoding?.contentType?.includes("json") === true) {
		form.append(name, json(value))
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item !== null && typeof item === "object") form.append(name, json(item))
			else form.append(name, String(item))
		}
		return
	}
	if (value !== null && typeof value === "object") {
		form.append(name, json(value))
		return
	}
	form.append(name, String(value))
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
