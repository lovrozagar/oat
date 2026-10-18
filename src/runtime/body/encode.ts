/**
 * Turns a generated field map into the body the document asked for.
 *
 * JSON stays a plain object. urlencoded becomes URLSearchParams. Multipart becomes
 * FormData — file parts are resolved (hook → pool → dummy), never JSON.stringified.
 */

import { requestContent } from "../../spec/collection/request.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { applyResolveInput } from "../input.ts"
import { encodeUrlencoded } from "./form-pairs.ts"
import { encodeMultipart } from "./multipart.ts"
import type { EncodedBody, EncodeOptions, EncodePlacement } from "./types.ts"

export function requestContentOf(op: OperationModel, model: SpecModel): ReturnType<typeof requestContent> {
	const raw = model.rawOperations.get(op.operationId)
	return raw === undefined ? null : requestContent(raw)
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

/** The body `op` documents, built from `fields`; a body-less document leaves `fields` as they are. */
export async function encodeForOperation(
	op: OperationModel,
	model: SpecModel,
	fields: Record<string, unknown>,
	{ uploads, variant = "baseline", index = 0 }: EncodePlacement,
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
