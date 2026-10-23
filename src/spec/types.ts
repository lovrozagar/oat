/** Minimal structural view of an OpenAPI 3.x document — only what oat reads. */

import type { HttpMethod } from "./methods.ts"

export type { HttpMethod } from "./methods.ts"

/**
 * A JSON Schema node as a spec states it: the keywords oat reads, each still untrusted and checked
 * where it is read. Extensions (`x-*`) and keywords oat ignores sit behind the index signature.
 */
export interface JsonSchema {
	$ref?: unknown
	$id?: unknown
	$schema?: unknown
	$anchor?: unknown
	$comment?: unknown
	$defs?: unknown
	definitions?: unknown
	type?: unknown
	enum?: unknown
	const?: unknown
	format?: unknown
	pattern?: unknown
	minLength?: unknown
	maxLength?: unknown
	minimum?: unknown
	maximum?: unknown
	exclusiveMinimum?: unknown
	exclusiveMaximum?: unknown
	multipleOf?: unknown
	properties?: unknown
	required?: unknown
	additionalProperties?: unknown
	patternProperties?: unknown
	propertyNames?: unknown
	unevaluatedProperties?: unknown
	dependentSchemas?: unknown
	items?: unknown
	prefixItems?: unknown
	additionalItems?: unknown
	unevaluatedItems?: unknown
	contains?: unknown
	minItems?: unknown
	maxItems?: unknown
	uniqueItems?: unknown
	allOf?: unknown
	anyOf?: unknown
	oneOf?: unknown
	not?: unknown
	if?: unknown
	then?: unknown
	else?: unknown
	title?: unknown
	description?: unknown
	default?: unknown
	examples?: unknown
	deprecated?: unknown
	readOnly?: unknown
	writeOnly?: unknown
	contentEncoding?: unknown
	contentMediaType?: unknown
	/* OpenAPI's own schema keywords. */
	nullable?: unknown
	example?: unknown
	discriminator?: unknown
	xml?: unknown
	externalDocs?: unknown
	/* oat's own: the name a file part is sent under. */
	filename?: unknown
	[extension: string]: unknown
}

export interface ParameterObject {
	name: string
	in: "path" | "query" | "header" | "cookie"
	required?: boolean
	schema?: JsonSchema
	description?: string
	[k: string]: unknown
}

export interface MediaTypeObject {
	schema?: JsonSchema
	encoding?: Record<string, { contentType?: string }>
}

export interface ResponseObject {
	description?: string
	content?: Record<string, MediaTypeObject>
}

export interface OperationObject {
	operationId?: string
	summary?: string
	tags?: string[]
	parameters?: ParameterObject[]
	requestBody?: { required?: boolean; content?: Record<string, MediaTypeObject> }
	responses?: Record<string, ResponseObject>
	security?: Array<Record<string, string[]>>
	[k: `x-${string}`]: unknown
}

export type PathItemObject = Record<string, OperationObject | unknown>

export interface OpenApiDocument {
	openapi?: string
	info?: Record<string, unknown>
	servers?: Array<{ url: string }>
	paths?: Record<string, PathItemObject>
	components?: { schemas?: Record<string, JsonSchema>; securitySchemes?: Record<string, unknown> }
	security?: Array<Record<string, string[]>>
	[k: `x-${string}`]: unknown
}

/** An operation lifted out of the document with its location attached. */
export interface Endpoint {
	operationId: string
	method: HttpMethod
	path: string
	op: OperationObject
}
