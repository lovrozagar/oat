/** Minimal structural view of an OpenAPI 3.x document — only what oat reads. */

import type { HttpMethod } from "./methods.ts"

export type { HttpMethod } from "./methods.ts"

export type SchemaObject = Record<string, unknown>

export interface ParameterObject {
	name: string
	in: "path" | "query" | "header" | "cookie"
	required?: boolean
	schema?: SchemaObject
	description?: string
	[k: string]: unknown
}

export interface MediaTypeObject {
	schema?: SchemaObject
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
	components?: { schemas?: Record<string, SchemaObject>; securitySchemes?: Record<string, unknown> }
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
