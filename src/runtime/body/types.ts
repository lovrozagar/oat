/** The shapes a request body is encoded through. */

import type { UploadContext } from "../upload.ts"

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

/** Where a body is encoded for: the uploads it may draw on, and the variant and record it is. */
export interface EncodePlacement {
	uploads: UploadContext
	variant?: string | undefined
	index?: number | undefined
}
