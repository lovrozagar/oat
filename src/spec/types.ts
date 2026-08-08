/** Minimal structural view of an OpenAPI 3.x document — only what oat reads. */

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

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** An operation lifted out of the document with its location attached. */
export interface Endpoint {
	operationId: string
	method: HttpMethod
	path: string
	op: OperationObject
}

export function listEndpoints(doc: OpenApiDocument): Endpoint[] {
	const out: Endpoint[] = []
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		if (item === null || typeof item !== "object") continue
		for (const method of HTTP_METHODS) {
			const op = (item as Record<string, unknown>)[method]
			if (op === null || typeof op !== "object") continue
			const operation = op as OperationObject
			out.push({
				method,
				op: operation,
				operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`,
				path,
			})
		}
	}
	return out
}
