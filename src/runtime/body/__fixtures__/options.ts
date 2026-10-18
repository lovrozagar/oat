/** Encode options and a document whose operations take every body kind the encoder writes. */

import type { UploadFile } from "../../../config/types/hooks.ts"
import { buildModel } from "../../../spec/graph/build.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import { dereference } from "../../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { EncodeOptions } from "../types.ts"

export function optionsOf(overrides: Partial<EncodeOptions> = {}): EncodeOptions {
	return {
		fields: {},
		index: 0,
		mediaType: "multipart/form-data",
		operationId: "docs.create",
		schema: { type: "object" },
		uploads: { seed: 7 },
		variant: "baseline",
		...overrides,
	}
}

export const PDF: UploadFile = {
	bytes: new Uint8Array([37, 80, 68, 70]),
	filename: "given.pdf",
	mediaType: "application/pdf",
}

/** The parts of a FormData as plain values: a string, or a file's name and type. */
export function partsOf(form: FormData): Array<[string, string | { name: string; type: string }]> {
	return [...form.entries()].map(([name, value]) => [
		name,
		typeof value === "string" ? value : { name: value.name, type: value.type },
	])
}

const ok = { 200: { description: "ok" } }
const object = {
	properties: { name: { type: "string" }, tags: { items: { type: "string" }, type: "array" } },
	type: "object",
}

const DOCUMENT = {
	info: { title: "bodies", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/docs": {
			get: { operationId: "docs.list", responses: ok },
			post: {
				operationId: "docs.create",
				requestBody: {
					content: {
						"multipart/form-data": {
							encoding: { tags: { explode: false } },
							schema: { ...object, properties: { ...object.properties, file: { format: "binary", type: "string" } } },
						},
					},
				},
				responses: ok,
			},
		},
		"/v1/docs/{id}": {
			patch: {
				operationId: "docs.update",
				requestBody: {
					content: { "application/x-www-form-urlencoded": { encoding: { tags: { explode: false } }, schema: object } },
				},
				responses: ok,
			},
			put: {
				operationId: "docs.replace",
				requestBody: { content: { "application/json": { schema: object } } },
				responses: ok,
			},
		},
	},
} as unknown as OpenApiDocument

export function bodiesModel(): SpecModel {
	return buildModel(dereference(DOCUMENT).doc)
}
