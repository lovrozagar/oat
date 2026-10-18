/**
 * A multipart body: file parts are resolved (hook → pool → dummy), never JSON.stringified, and
 * every other field becomes the part its encoding names.
 */

import type { UploadFile, UploadResolution } from "../../config/types/hooks.ts"
import { isFieldOverride, isUploadFile, resolveUploadOverride } from "../upload.ts"
import { appendFields, appendFile, appendValue } from "./form-data.ts"
import { additionalSchema, isFilePart, propertiesOf, requiredOf } from "./schema.ts"
import type { EncodeOptions } from "./types.ts"
import { fileForPart, filePartNames, overrideIncludesFile, uploadRequest } from "./upload-parts.ts"

/**
 * The file-typed `additionalProperties` part for the first required field no property sent,
 * unless the form already holds a file. A required file property was sent as one by then.
 */
async function appendAdditionalFile(
	form: FormData,
	options: EncodeOptions,
	sent: Set<string>,
	required: string[],
): Promise<void> {
	const additional = additionalSchema(options.schema)
	if (additional === undefined || !isFilePart(additional, undefined)) return
	const already = [...form.keys()].some((name) => form.get(name) instanceof File)
	if (already) return
	const name = required.find((item) => !sent.has(item))
	if (name === undefined) return
	appendFile(form, name, await fileForPart(name, additional, options))
}

/** A non-file property's value, when it has one. */
function appendProperty(form: FormData, name: string, options: EncodeOptions): void {
	const value = options.fields[name]
	if (value === undefined || value === null) return
	appendValue(form, name, value, options.encoding?.[name])
}

/** The same options with the upload hook taken out: the hook was asked already. */
function withoutHook(options: EncodeOptions): EncodeOptions {
	return { ...options, uploads: { ...options.uploads, resolveUpload: undefined } }
}

export async function encodeMultipart(options: EncodeOptions): Promise<FormData> {
	const form = new FormData()
	const properties = propertiesOf(options.schema)
	const required = requiredOf(options.schema)
	const names = filePartNames(properties, required, options)
	const hookHits = new Map<string, UploadResolution>()
	const overlays: Array<Record<string, string | UploadFile>> = []
	for (const name of names) {
		/* A file the caller names itself (a scenario step's body) is that part; no hook overrides it. */
		const given = options.fields[name]
		if (isUploadFile(given)) {
			hookHits.set(name, given)
			continue
		}
		/* A file part is a property, or the required field `additionalProperties` types as a file. */
		const schema = properties[name] ?? (additionalSchema(options.schema) as Record<string, unknown>)
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
		if (!isFilePart(schema, options.encoding?.[name])) {
			appendProperty(form, name, options)
			continue
		}
		const hit = hookHits.get(name)
		const file = isUploadFile(hit) ? hit : await fileForPart(name, schema, withoutHook(options))
		appendFile(form, name, file)
	}

	await appendAdditionalFile(form, options, sent, required)
	for (const overlay of overlays) appendFields(form, overlay)
	return form
}
