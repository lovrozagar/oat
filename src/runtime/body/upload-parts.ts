/** The file parts of a multipart body: which fields they are, and the file each one sends. */

import type { UploadFile, UploadRequest } from "../../config/types/hooks.ts"
import { isUploadFile, resolveUploadFile } from "../upload.ts"
import { additionalSchema, contentMediaTypeOf, isFilePart } from "./schema.ts"
import type { EncodeOptions } from "./types.ts"
import type { JsonSchema } from "../../spec/types.ts"

/** Whether a hook's field override already carries one of the body's file parts. */
export function overrideIncludesFile(
	fields: Record<string, string | UploadFile>,
	fileNames: readonly string[],
): boolean {
	for (const [name, value] of Object.entries(fields)) {
		if (isUploadFile(value) && fileNames.includes(name)) return true
	}
	return false
}

/**
 * The fields that are files: every file property, or else the one required field the schema
 * names only through a file-typed `additionalProperties`.
 */
export function filePartNames(
	properties: Record<string, JsonSchema>,
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

export function uploadRequest(name: string, schema: JsonSchema, options: EncodeOptions): UploadRequest {
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

export async function fileForPart(name: string, schema: JsonSchema, options: EncodeOptions): Promise<UploadFile> {
	const request = uploadRequest(name, schema, options)
	const file = await resolveUploadFile(request, options.uploads)
	return file
}
